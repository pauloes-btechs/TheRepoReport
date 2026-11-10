/** The subset of GitHub REST API response fields the collector reads. */

export interface GhUser {
  login: string;
  type?: string;
}

export interface GhLabel {
  name: string;
}

export interface GhRepo {
  full_name: string;
  html_url?: string;
  stargazers_count?: number;
  pushed_at?: string | null;
  topics?: string[];
  archived?: boolean;
}

export interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  author?: GhUser | null;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  user?: GhUser | null;
  labels?: GhLabel[];
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  user?: GhUser | null;
  labels?: (GhLabel | string)[];
  comments?: number;
  reactions?: { total_count?: number };
  created_at: string;
  updated_at: string;
  /** Present when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

export interface GhAdvisory {
  ghsa_id: string;
  cve_id: string | null;
  html_url: string;
  summary: string;
  description: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  created_at?: string;
  updated_at?: string;
  published_at: string | null;
  vulnerabilities?: { patched_versions?: string | null; package?: { name?: string } | null }[] | null;
}
