// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  Flags,
  Issue,
  IssueResult,
  Repo,
  IssuesApiResponse,
  ApiIssue,
} from './types';
import {octo, repos, teams} from './util';
import {request, GaxiosResponse} from 'gaxios';
import Table = require('cli-table');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const truncate = require('truncate');
import * as CSV from 'csv-string';

const apiKey = process.env.DRIFT_API_KEY;
if (!apiKey) {
  throw new Error(
    'Please access the `Yoshi Drift Key` secret in go/valentine, and set the `DRIFT_API_KEY` env var.'
  );
}

/**
 * Walk over each configured repository, and obtain a list of issues.
 * @param flags
 */
export async function getIssues(flags?: Flags): Promise<IssueResult[]> {
  // This fetch is done serially on purpose. When using the `Promise.all`
  // approach, it was generating too many concurrent request and causing
  // 503 errors in the underlying API.  Slowing it to a serial fetch will
  // make it linearly slower, but more predictable and safe.
  const results = new Array<IssueResult>();
  for (const repo of repos) {
    // if we're filtering by --language, don't even snag the issues
    if (flags && flags.language && repo.language !== flags.language) {
      continue;
    }
    const r = await getRepoIssues(repo, flags);
    results.push(r);
  }
  return results;
}

async function getRepoIssues(repo: Repo, flags?: Flags): Promise<IssueResult> {
  const [owner, name] = repo.repo.split('/');
  const result = {issues: new Array<Issue>(), repo};
  let res!: GaxiosResponse<IssuesApiResponse>;
  const rootUrl = 'https://drghs.endpoints.devrel-prod.cloud.goog/api/v1';
  const fieldMask = [
    'assignees',
    'closedAt',
    'createdAt',
    'is_pr',
    'issueId',
    'issueType',
    'labels',
    'priority',
    'priorityUnknown',
    'repo',
    'reporter',
    'title',
    'updatedAt',
    'url',
  ].join(',');

  let pageToken = '';
  while (pageToken === '' && result.issues.length < 1) {
    let url = `${rootUrl}/${repo.repo}/issues?key=${apiKey}&closed=false&field_mask=${fieldMask}`;
    if (pageToken !== '') {
      url = url + `&page=${pageToken}`;
    }

    try {
      res = await request<IssuesApiResponse>({url});
    } catch (e) {
      console.warn(`Error fetching issues for ${repo.repo}.`);
      // console.warn(e);
      return result;
    }

    if (!res.data || !res.data.issues) {
      return result;
    }

    pageToken = res!.data.nextPageToken;

    const issues = res!.data.issues;
    for (const rIssue of issues) {
      const api = getApi(rIssue);
      const issue: Issue = {
        owner,
        name,
        language: repo.language,
        repo: repo.repo,
        types: getTypes(rIssue),
        api,
        team: getTeam(rIssue.repo, api),
        isOutOfSLO: isOutOfSLO(rIssue),
        isTriaged: isTriaged(rIssue),
        pri: rIssue.priorityUnknown ? undefined : getPriority(rIssue.priority),
        isPR: !!rIssue.isPr,
        number: rIssue.issueId,
        createdAt: rIssue.createdAt,
        title: rIssue.title,
        url: rIssue.url,
        labels: rIssue.labels || [],
        assignees: rIssue.assignees ? rIssue.assignees.map(x => x.login) : [],
      };

      let use = true;
      if (flags) {
        if (flags.api) {
          const apiTypes = flags.api
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);
          if (!issue.api || apiTypes.indexOf(issue.api) === -1) {
            use = false;
          }
        }
        if (flags.repo && rIssue.repo !== flags.repo) {
          use = false;
        }
        if (flags.outOfSlo && !issue.isOutOfSLO) {
          use = false;
        }
        if (flags.untriaged && issue.isTriaged) {
          use = false;
        }
        if (flags.team && issue.team !== flags.team) {
          use = false;
        }
        if (flags.pri && `p${issue.pri}` !== flags.pri) {
          use = false;
        }
        if (flags.pr && !issue.isPR) {
          use = false;
        }
        if (flags.type) {
          const flagTypes = flags.type
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);
          let found = false;
          for (const flagType of flagTypes) {
            for (const issueType of issue.types) {
              if (flagType === issueType) {
                found = true;
              }
            }
          }
          if (!found) {
            use = false;
          }
        }
      }
      if (use) {
        result.issues.push(issue);
      }
    }
  }
  return result;
}

export interface IssueOptions {
  csv?: boolean;
  untriaged?: boolean;
  outOfSLO?: boolean;
  repository?: string;
  language?: string;
  api?: string;
  pr?: boolean;
}

export async function tagIssues() {
  const promises = new Array<Promise<void | {}>>();
  const repos = await getIssues();
  repos.forEach(r => {
    r.issues.forEach(i => {
      const [owner, name] = r.repo.repo.split('/');
      i.repo = name;
      i.owner = owner;
      const hasTriageMeLabel = i.labels.includes('triage me');
      const hasOOSLOLabel = i.labels.includes(':rotating_light:');
      if (!i.isTriaged && !hasTriageMeLabel && hoursOld(i.createdAt) > 16) {
        console.log(`Tagging ${i.repo}#${i.number} with 'triage me'`);
        promises.push(tagIssue(i, 'triage me'));
      } else if (i.isTriaged && hasTriageMeLabel) {
        console.log(`Un-Tagging ${i.repo}#${i.number} with 'triage me'`);
        promises.push(untagIssue(i, 'triage me'));
      }
      if (i.isOutOfSLO && !hasOOSLOLabel) {
        console.log(`Tagging ${i.repo}#${i.number} with '🚨'`);
        promises.push(tagIssue(i, ':rotating_light:'));
      } else if (!i.isOutOfSLO && hasOOSLOLabel) {
        console.log(`Un-tagging ${i.repo}#${i.number} with '🚨'`);
        promises.push(untagIssue(i, ':rotating_light:'));
      }
    });
  });
  await Promise.all(promises);
}

function tagIssue(i: Issue, label: string) {
  return octo.issues
    .addLabels({
      labels: [label],
      issue_number: i.number,
      owner: i.owner,
      repo: i.repo,
    })
    .catch(e => {
      console.error(`Error tagging ${i.repo}#${i.number} with '${label}'`);
      console.error(e);
    });
}

function untagIssue(i: Issue, label: string) {
  return octo.issues
    .removeLabel({
      name: label,
      issue_number: i.number,
      owner: i.owner,
      repo: i.repo,
    })
    .catch(e => {
      console.error(`Error un-tagging ${i.repo}#${i.number} with '${label}'`);
      console.error(e);
    });
}

// tslint:disable-next-line no-any
export async function showIssues(options: Flags) {
  const repos = await getIssues(options);
  const issues = new Array<Issue>();
  repos.forEach(r => {
    r.issues.forEach(i => issues.push(i));
  });
  let table: Table;
  const output = new Array<string>();
  const head = [
    'Issue',
    'Triaged',
    'InSLO',
    'Title',
    'Language',
    'API',
    'Pri',
    'Team',
  ];

  if (options.csv) {
    output.push(CSV.stringify(head));
  } else {
    table = new Table({head});
  }

  issues.forEach(issue => {
    const values = [
      issue.url,
      options.csv ? issue.isTriaged : issue.isTriaged ? '🦖' : '🚨',
      options.csv ? !issue.isOutOfSLO : !issue.isOutOfSLO ? '🦖' : '🚨',
      truncate(issue.title, 75),
      issue.language,
      issue.api || '',
      issue.pri || '',
      issue.team,
    ];
    if (options.csv) {
      output.push(CSV.stringify(values));
    } else {
      table.push(values);
    }
  });

  if (table!) {
    output.push(table!.toString());
  }

  output.forEach(l => process.stdout.write(l));
  process.stdout.write('\n');
}

function getTypes(i: ApiIssue) {
  const types = new Array<string>();
  if (i.labels) {
    for (const label of i.labels.sort()) {
      if (label.startsWith('type: ')) {
        types.push(label.slice(6));
      }
    }
  }
  return types;
}

// As a part of the gRPC API, the Priority of the Issue is
// now sent back as a string. "P0", "P1", "P2" etc.
export const getPriority = (p: string) => Number(p.toLowerCase().slice(1));

function getApi(i: ApiIssue): string | undefined {
  if (i.labels) {
    for (const label of i.labels.sort()) {
      if (label.startsWith('api: ')) {
        return label.slice(5);
      }
    }
  }
  return undefined;
}

function getTeam(repo: string, api?: string) {
  // if repo issues are managed by a single team, attribute to that team
  const r = repos.find(x => x.repo === repo);
  const t = teams.find(x => (x.repos || []).includes(repo));
  if (r) {
    if (r.isTeamIssue && t) {
      return t.name;
    }
  }

  // next look for an api label and attribute team accordingly
  if (api) {
    const t = teams.find(x => (x.apis || []).includes(api));
    if (t) {
      return t.name;
    }
  }

  // if no api label
  if (t) {
    return t.name;
  }

  // if no api and no explicit team owner
  return 'core';
}

/**
 * Determine if an issue has a `priority: ` label.
 * @param i Issue to analyze
 */
function hasPriority(i: ApiIssue) {
  return hasLabel(i, 'priority: ');
}

/**
 * Determine if an issue has a `type: ` label.
 * @param i Issue to analyze
 */
function hasType(i: ApiIssue) {
  return hasLabel(i, 'type: ');
}

/**
 * Determine if an issue has a `type: bug` label.
 * @param i Issue to analyze
 */
function isBug(i: ApiIssue) {
  return hasLabel(i, 'type: bug');
}

/**
 * Check if there is a label that matches the given text.
 * @param issue Issue to analyze
 * @param label Label text to look for
 */
function hasLabel(issue: ApiIssue, label: string) {
  return (
    issue.labels &&
    issue.labels.filter(x => x.toLowerCase().indexOf(label) > -1).length > 0
  );
}

/**
 * For a given issue, figure out if it's out of SLO.
 * @param i Issue to analyze
 */
function isOutOfSLO(i: ApiIssue) {
  const pri = i.priorityUnknown ? undefined : getPriority(i.priority);

  // Previously we applied rules around Pull Request closure SLOs.
  // It had the unintended consequence of folks feeling forced to rush landing
  // PRs early, when the intent was to cast a light on PRs that may have been
  // forgotten.  We will come back around and use a bot to solve this in the
  // future.
  if (i.isPr) {
    return false;
  }

  // Ignore any issues which are blocked by external APIs
  if (isExternal(i)) {
    return false;
  }

  // Priority is only a trigger for an SLO if it's one of the following types:
  // - question
  // - bug
  // - docs
  const isCustomerIssue =
    hasLabel(i, 'type: question') ||
    hasLabel(i, 'type: docs') ||
    hasLabel(i, 'type: bug');

  // +----------+----------+---------+
  // | Priority | Response | Closure |
  // +----------+----------+---------+
  // |        0 |        1 | 1       |
  // |        1 |        1 | 7       |
  // |        2 |     5/90 | 180     |
  // |        3 |      180 | N/A     |
  // |        4 |      365 | N/A     |
  // +----------+----------+---------+
  if (isCustomerIssue) {
    // All P0 issues must receive a reply within 1 day, an update at least daily,
    // and be resolved within 1 day.
    if (pri === 0) {
      if (daysOld(i.createdAt) > 1 || daysOld(i.updatedAt) > 1) {
        return true;
      }
    }

    // All P1 issues must receive a reply within 5 days, an update at least every
    // 5 days thereafter, and be resolved within 7 days.
    if (pri === 1) {
      if (daysOld(i.createdAt) > 7 || daysOld(i.updatedAt) > 5) {
        return true;
      }
    }

    // All P2 issues must receive a reply within 5 days initially, 90 days
    // after, and be resolved within 180 days.
    if (pri === 2) {
      if (daysOld(i.createdAt) > 180 || daysOld(i.updatedAt) > 90) {
        return true;
      }
    }

    // All P3 issues must receive a reply every 180 days
    if (pri === 3) {
      if (daysOld(i.updatedAt) > 180) {
        return true;
      }
    }

    // All P3 issues must receive a reply every 365 days
    if (pri === 4) {
      if (daysOld(i.updatedAt) > 365) {
        return true;
      }
    }
  }

  // All questions must receive a reply within 5 days.
  if (hasLabel(i, 'type: question')) {
    if (!i.updatedAt && daysOld(i.createdAt) > 5) {
      return true;
    }
  }

  // All feature requests must receive a reply within 5 days
  if (hasLabel(i, 'type: feature')) {
    if (!i.updatedAt && daysOld(i.createdAt) > 5) {
      return true;
    }
    // We decided in a team meeting to drop this requirement.
    // if (daysOld(i.created_at) > 180) {
    //   return true;
    // }
  }

  // Make sure if it hasn't been triaged, it's less than 5 days old
  if (!isTriaged(i) && daysOld(i.createdAt) > 5) {
    return true;
  }

  // It's all good then!
  return false;
}

/**
 * Determine how many days old an issue is
 * @param date Date to compare
 */
function daysOld(date: string) {
  return (Date.now() - new Date(date).getTime()) / 1000 / 60 / 60 / 24;
}

/**
 * Determine how many hours old an issue is
 * @param date Date to compare
 */
function hoursOld(date: string) {
  return (Date.now() - new Date(date).getTime()) / 1000 / 60 / 60;
}

function isExternal(i: ApiIssue) {
  return hasLabel(i, 'external');
}

/**
 * Determine if an issue has been triaged. An issue is triaged if:
 * - It has a `priority` label OR
 * - It has a `type` label
 * - For `type: bug`, there must be a `priority` label
 * - For a P0 or P1 issue, it must have an asignee
 * - Pull requests don't count.
 * @param i Issue to analyze
 */
function isTriaged(i: ApiIssue) {
  if (i.isPr) {
    return true;
  }

  if (hasPriority(i)) {
    return true;
  }

  if (hasType(i)) {
    if (isBug(i)) {
      return hasPriority(i);
    }
    return true;
  }

  if (hasLabel(i, 'status: investigating')) {
    return true;
  }

  return false;
}
