/**
 * GitHub 官方 GraphQL API 与 Token 认证服务。
 * 支持查询包含 Private 仓库贡献在内的完整贡献日历，以及验证用户 Token 并获取权限数据。
 */

export interface ValidatedGitHubUser {
  username: string;
  name: string;
  avatarUrl: string;
  publicRepos: number;
  totalPrivateRepos: number;
}

export function formatAuthHeader(token: string): string {
  const clean = token.trim();
  if (clean.startsWith("Bearer ") || clean.startsWith("token ")) {
    return clean;
  }
  return `Bearer ${clean}`;
}

/**
 * 验证 GitHub Personal Access Token 并返回已认证用户的信息
 */
export async function validateGitHubToken(token: string): Promise<ValidatedGitHubUser> {
  const authHeader = formatAuthHeader(token);
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: authHeader,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid GitHub token (Bad credentials). Please check your token.");
    }
    throw new Error(`GitHub token verification failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const username = String(data.login || "");
  if (!username) {
    throw new Error("Failed to resolve GitHub username from token.");
  }

  return {
    username,
    name: String(data.name || data.login || username),
    avatarUrl: String(data.avatar_url || `https://github.com/${username}.png`),
    publicRepos: Number(data.public_repos ?? 0),
    totalPrivateRepos: Number(
      data.total_private_repos ?? data.owned_private_repos ?? 0,
    ),
  };
}

/**
 * 使用 GraphQL API 查询经过认证的 viewer 贡献日历（包含私人仓库贡献）
 */
export async function fetchAuthenticatedContributions(token: string): Promise<{
  contributions: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }>;
  totalContributions: number;
} | null> {
  const query = `
    query {
      viewer {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                contributionLevel
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: formatAuthHeader(token),
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        viewer?: {
          contributionsCollection?: {
            contributionCalendar?: {
              totalContributions?: number;
              weeks?: Array<{
                contributionDays?: Array<{
                  date: string;
                  contributionCount: number;
                  contributionLevel: string;
                }>;
              }>;
            };
          };
        };
      };
    };

    const calendar = json?.data?.viewer?.contributionsCollection?.contributionCalendar;
    if (!calendar || !Array.isArray(calendar.weeks)) return null;

    const levelMap: Record<string, 0 | 1 | 2 | 3 | 4> = {
      NONE: 0,
      FIRST_QUARTILE: 1,
      SECOND_QUARTILE: 2,
      THIRD_QUARTILE: 3,
      FOURTH_QUARTILE: 4,
    };

    const contributions: Array<{ date: string; count: number; level: 0 | 1 | 2 | 3 | 4 }> = [];
    for (const week of calendar.weeks) {
      for (const day of week.contributionDays ?? []) {
        contributions.push({
          date: day.date,
          count: day.contributionCount,
          level: levelMap[day.contributionLevel] ?? (day.contributionCount > 0 ? 1 : 0),
        });
      }
    }

    return {
      contributions,
      totalContributions:
        calendar.totalContributions ??
        contributions.reduce((s, c) => s + c.count, 0),
    };
  } catch {
    return null;
  }
}
