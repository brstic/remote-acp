/**
 * Bugboard's issue data: an in-memory project per demo user, seeded with the
 * "acme-web" issues. Each demo user gets their own copy so people trying the
 * example never see each other's comments or agent runs.
 */

export type IssueStatus = "open" | "in_progress" | "in_review" | "done";
export const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "in_progress", "in_review", "done"];
/** Statuses an agent may set through the MCP tools (never "done": a human closes issues). */
export const AGENT_STATUSES: readonly IssueStatus[] = ["in_progress", "in_review"];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export type AuthorKind = "human" | "agent" | "system";

export interface Comment {
  id: string;
  author: string;
  authorKind: AuthorKind;
  body: string;
  createdAt: string;
  /** Set for comments an agent posted during a run. */
  runId?: string;
}

export interface Issue {
  id: string; // e.g. "BUG-101"
  title: string;
  description: string;
  steps: string[];
  expected: string;
  actual: string;
  stackTrace?: string;
  labels: string[];
  status: IssueStatus;
  reporter: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  /** Bumped on every change; used as the SSE event id of issue snapshots. */
  version: number;
}

export interface Project {
  key: string;
  name: string;
  description: string;
  issues: Map<string, Issue>;
}

export const MAX_COMMENT_BYTES = 8 * 1024;
const MAX_COMMENTS_PER_ISSUE = 200;

type SeedIssue = Omit<Issue, "comments" | "version" | "updatedAt" | "createdAt"> & {
  ageHours: number;
  comments: { author: string; body: string; ageHours: number }[];
};

/**
 * The seeded "acme-web" issues. BUG-101 is a real bug in sample-project/
 * (src/slugify.js). The texts avoid the Test agent's scenario keywords,
 * except BUG-103 ("slow": a long streamed run for cancel demos) and BUG-104
 * ("permission": the Test agent asks for a local permission).
 */
const SEED: SeedIssue[] = [
  {
    id: "BUG-101",
    title: "Product URLs keep uppercase letters and repeated dashes",
    description:
      "Slugs generated for new products keep the original capitalisation and turn every punctuation character into its own dash. " +
      "Marketing noticed `/products/Summer-Sale----50--OFF` in a campaign email; the canonical URL (and our sitemap) expects lowercase, single dashes. " +
      "Links that differ only by case are indexed twice by search engines.",
    steps: [
      "In the admin, create a product titled `Summer Sale -- 50% OFF!`",
      "Open the product page from the storefront",
      "Look at the URL",
    ],
    expected: "`/products/summer-sale-50-off`",
    actual: "`/products/Summer-Sale----50--OFF`",
    labels: ["bug", "seo", "good first issue"],
    status: "open",
    reporter: "maria",
    assignee: null,
    ageHours: 30,
    comments: [
      { author: "maria", body: "The slug comes from `slugify()` in `src/slugify.js`. The unit tests only cover lowercase titles, which is probably why nobody noticed.", ageHours: 29 },
      { author: "devon", body: "Please keep the accent stripping as it is. `crème brûlée` must stay `creme-brulee`.", ageHours: 20 },
    ],
  },
  {
    id: "BUG-102",
    title: "Checkout total shows NaN when the coupon field is left empty",
    description:
      "If a customer focuses the coupon field and then leaves it empty, the order summary shows `Total: $NaN` and the Pay button is disabled. " +
      "Removing the coupon parameter from the request fixes it, so the empty string is probably treated as a discount.",
    steps: ["Add any product to the cart", "Go to checkout", "Click into the coupon field, then click somewhere else", "Look at the order summary"],
    expected: "The total stays at the cart total and Pay stays enabled.",
    actual: "`Total: $NaN`; the Pay button is disabled.",
    stackTrace: [
      "TypeError: Cannot read properties of undefined (reading 'amount')",
      "    at applyCoupon (src/checkout/coupons.js:41:23)",
      "    at computeTotals (src/checkout/totals.js:18:14)",
      "    at CheckoutSummary.render (src/checkout/CheckoutSummary.js:57:9)",
    ].join("\n"),
    labels: ["bug", "checkout", "p1"],
    status: "in_progress",
    reporter: "sam",
    assignee: "devon",
    ageHours: 52,
    comments: [
      { author: "devon", body: "Reproduced on staging. Looking into `applyCoupon`.", ageHours: 26 },
      { author: "sam", body: "Support has had 14 tickets about this since Friday.", ageHours: 8 },
    ],
  },
  {
    id: "BUG-103",
    title: "Product search is slow on catalogs with 10k+ items",
    description:
      "Typing in the search box on large catalogs takes 2-3 seconds per keystroke. The profiler shows `parseQuery` and the filter running for every product on every keystroke, without debouncing.",
    steps: ["Import the 12k product fixture", "Type `red shoes` into the storefront search box"],
    expected: "Results update within ~150 ms after the user stops typing.",
    actual: "Each keystroke blocks the UI for 2-3 seconds.",
    labels: ["performance", "search"],
    status: "open",
    reporter: "lee",
    assignee: null,
    ageHours: 75,
    comments: [{ author: "lee", body: "Profile attached in the internal drive (search-profile-0412.json).", ageHours: 74 }],
  },
  {
    id: "BUG-104",
    title: "Newsletter signup asks for notification permission on every page load",
    description:
      "The newsletter widget calls `Notification.requestPermission()` on mount, so returning visitors who dismissed the prompt see it again on each page. It should only ask after the user clicks Subscribe.",
    steps: ["Open the storefront in a fresh profile", "Dismiss the browser prompt", "Navigate to any other page"],
    expected: "The browser prompt appears only after clicking Subscribe.",
    actual: "The prompt appears on every navigation.",
    labels: ["bug", "ux"],
    status: "open",
    reporter: "maria",
    assignee: null,
    ageHours: 98,
    comments: [],
  },
  {
    id: "BUG-105",
    title: "Dark mode preference resets after reload",
    description: "Choosing Dark in the theme menu works until the page is reloaded; then the site is light again.",
    steps: ["Pick Dark in the theme menu", "Reload the page"],
    expected: "The site stays dark.",
    actual: "The site switches back to light.",
    labels: ["bug", "ui"],
    status: "done",
    reporter: "devon",
    assignee: "lee",
    ageHours: 200,
    comments: [
      { author: "lee", body: "The preference was saved under `theme` but read from `color-theme`. Fixed in #482.", ageHours: 150 },
      { author: "devon", body: "Verified on production. Closing.", ageHours: 140 },
    ],
  },
];

let commentSeq = 0;
const newCommentId = () => `c${(++commentSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function seedProject(now = Date.now()): Project {
  const iso = (ageHours: number) => new Date(now - ageHours * 3_600_000).toISOString();
  const issues = new Map<string, Issue>();
  for (const s of SEED) {
    const { ageHours, comments, ...rest } = s;
    const issue: Issue = {
      ...rest,
      steps: [...rest.steps],
      labels: [...rest.labels],
      createdAt: iso(ageHours),
      updatedAt: iso(comments.at(-1)?.ageHours ?? ageHours),
      comments: comments.map((c) => ({ id: newCommentId(), author: c.author, authorKind: "human", body: c.body, createdAt: iso(c.ageHours) })),
      version: 1,
    };
    issues.set(issue.id, issue);
  }
  return {
    key: "acme-web",
    name: "acme-web",
    description: "Acme's storefront: product pages, search and checkout helpers.",
    issues,
  };
}

export class TrackerError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_comment" | "invalid_status" | "too_many_comments",
    message: string,
  ) {
    super(message);
  }
}

/** Trim, normalise newlines and drop control characters (keeps \n and \t). */
export function cleanText(input: unknown, maxBytes: number): string {
  if (typeof input !== "string") return "";
  let s = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  while (Buffer.byteLength(s) > maxBytes) s = s.slice(0, Math.max(0, s.length - Math.ceil((Buffer.byteLength(s) - maxBytes) / 4) - 1));
  return s;
}

/** All projects, keyed by demo username. Emits a change event per mutated issue. */
export class Tracker {
  private readonly projects = new Map<string, Project>();

  constructor(
    private readonly onChange: (username: string, issue: Issue) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  project(username: string): Project {
    let p = this.projects.get(username);
    if (!p) this.projects.set(username, (p = seedProject(this.now())));
    return p;
  }

  issue(username: string, id: string): Issue {
    const i = this.project(username).issues.get(id);
    if (!i) throw new TrackerError("not_found", `Issue ${id} not found.`);
    return i;
  }

  addComment(username: string, id: string, c: { author: string; authorKind: AuthorKind; body: unknown; runId?: string }): Comment {
    const issue = this.issue(username, id);
    if (typeof c.body !== "string") throw new TrackerError("invalid_comment", "Comment body must be a string.");
    if (Buffer.byteLength(c.body) > MAX_COMMENT_BYTES) throw new TrackerError("invalid_comment", `Comment body is longer than ${MAX_COMMENT_BYTES} bytes.`);
    const body = cleanText(c.body, MAX_COMMENT_BYTES);
    if (!body) throw new TrackerError("invalid_comment", "Comment body must not be empty.");
    if (issue.comments.length >= MAX_COMMENTS_PER_ISSUE) throw new TrackerError("too_many_comments", "This issue has too many comments.");
    const comment: Comment = {
      id: newCommentId(),
      author: c.author,
      authorKind: c.authorKind,
      body,
      createdAt: new Date(this.now()).toISOString(),
      ...(c.runId ? { runId: c.runId } : {}),
    };
    issue.comments.push(comment);
    this.touch(username, issue);
    return comment;
  }

  setStatus(username: string, id: string, status: unknown, by: { author: string; authorKind: AuthorKind; runId?: string }): Issue {
    const issue = this.issue(username, id);
    if (typeof status !== "string" || !(ISSUE_STATUSES as readonly string[]).includes(status)) {
      throw new TrackerError("invalid_status", `Status must be one of: ${ISSUE_STATUSES.join(", ")}.`);
    }
    const next = status as IssueStatus;
    if (issue.status === next) return issue;
    const prev = issue.status;
    issue.status = next;
    // A small system entry in the timeline, like real trackers do.
    issue.comments.push({
      id: newCommentId(),
      author: by.author,
      authorKind: "system",
      body: `changed the status from ${STATUS_LABEL[prev]} to ${STATUS_LABEL[next]}`,
      createdAt: new Date(this.now()).toISOString(),
      ...(by.runId ? { runId: by.runId } : {}),
    });
    this.touch(username, issue);
    return issue;
  }

  /** Mark an issue changed without data changes (e.g. a run started). */
  touch(username: string, issue: Issue): void {
    issue.version++;
    issue.updatedAt = new Date(this.now()).toISOString();
    this.onChange(username, issue);
  }
}
