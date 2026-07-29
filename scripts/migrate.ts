#!/usr/bin/env bun
/**
 * Mirror GitHub repositories into Arbor.
 *
 * Built for the dual-remote transition: repositories land in Arbor with full
 * history while GitHub stays the Fractal deploy source, so nothing about the
 * deploy pipeline changes until the operator is host-agnostic.
 *
 * Two credentials are needed, because they authenticate different surfaces:
 *
 * - ARBOR_SESSION_TOKEN: an IDP session token (copy the access token out of
 *   the browser on arbor.omni.dev). Creating an ORGANIZATION repository needs
 *   this: Arbor derives org membership purely from IDP claims, and a personal
 *   access token deliberately carries none, so a PAT cannot create org repos.
 * - ARBOR_PAT: a personal access token, used as the git password for the
 *   mirror push. It must belong to the user who owns the repositories in
 *   Arbor (or a collaborator on them); org membership alone does not grant a
 *   token git access.
 *
 * Dry run by default. Nothing is created or pushed without --apply, and
 * GitHub is only ever read from.
 *
 * Usage:
 *   bun scripts/migrate.ts [options] <owner/repo...>
 *
 * Options:
 *   --apply              perform the migration (default is a dry run)
 *   --list-orgs          print Arbor organizations you can see, then exit
 *   --org-id <rowId>     create repositories under this Arbor organization
 *   --visibility <v>     public | private (default: mirror the GitHub setting)
 *   --add-remote <path>  add an `arbor` remote to the clone at this path
 *   --api <url>          Arbor API base (default https://api.arbor.omni.dev)
 *   --git-host <host>    Arbor git host (default git.arbor.omni.dev)
 */

/** A GitHub repository identified by owner and name */
export interface RepoSpec {
  owner: string;
  name: string;
}

/**
 * Parse a repository argument.
 *
 * Accepts `owner/name`, an HTTPS URL, or an SSH URL, so the same list works
 * whether it came from `gh repo list`, a browser, or a git remote.
 */
export const parseRepoSpec = (input: string): RepoSpec | null => {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "");

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return null;

  const [owner, name] = parts;
  if (!owner || !name) return null;

  return { owner, name };
};

/**
 * Derive a URL-friendly slug.
 *
 * Arbor addresses repositories by slug, so a GitHub name that is not already
 * slug-shaped has to be normalized rather than passed through.
 */
export const toSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Build the Arbor clone URL for an owner and slug */
export const arborCloneUrl = (
  gitHost: string,
  owner: string,
  slug: string,
): string => `https://${gitHost}/${owner}/${slug}.git`;

/** Outcome of comparing source refs against destination refs */
export interface RefDiff {
  /** Refs present on the source but absent on the destination */
  missing: string[];
  /** Refs present on both but pointing at different commits */
  mismatched: string[];
  /** Refs present only on the destination */
  extra: string[];
  /** Whether every source ref is present on the destination at the same commit */
  inSync: boolean;
}

/**
 * Compare two ref maps.
 *
 * Extra destination refs are reported but do not fail the check: a mirror push
 * adds and updates refs, and treating a ref that only exists in Arbor as a
 * failure would make re-running the tool noisy for no benefit.
 */
export const diffRefs = (
  source: Map<string, string>,
  destination: Map<string, string>,
): RefDiff => {
  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const [ref, sha] of source) {
    const target = destination.get(ref);
    if (target === undefined) {
      missing.push(ref);
    } else if (target !== sha) {
      mismatched.push(ref);
    }
  }

  const extra = [...destination.keys()].filter((ref) => !source.has(ref));

  return {
    missing,
    mismatched,
    extra,
    inSync: missing.length === 0 && mismatched.length === 0,
  };
};

/** Parse `git ls-remote` output into a ref -> sha map */
export const parseLsRemote = (output: string): Map<string, string> => {
  const refs = new Map<string, string>();

  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    // peeled tag entries (refs/tags/x^{}) duplicate the tag's target; the tag
    // ref itself is what a mirror compares on
    if (!sha || !ref || ref.endsWith("^{}")) continue;
    refs.set(ref, sha);
  }

  return refs;
};

// ---------------------------------------------------------------------------
// Effects below this line. Everything above is pure and unit-tested.
// ---------------------------------------------------------------------------

/** Run a command, returning stdout; throws with stderr on failure */
const run = async (
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  }

  return stdout;
};

/** Execute a GraphQL operation against the Arbor API */
const graphql = async (
  api: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${api}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }

  return body.data ?? {};
};

// Slugs are unique per owner rather than globally, so the organization has to
// be part of the check or an unrelated repository elsewhere reads as "exists"
// The git clone path is always {ownerUsername}/{slug}: resolveRepositorySummary
// joins repository.ownerId to user.username, so an organization repository is
// still addressed by the username of the user who created it. --org-id
// therefore affects ownership and billing, not the URL
const OBSERVER_QUERY = /* GraphQL */ `
  query Observer {
    observer {
      rowId
    }
  }
`;

const USERNAME_QUERY = /* GraphQL */ `
  query Username($id: UUID!) {
    users(filter: { rowId: { equalTo: $id } }, first: 1) {
      nodes {
        username
      }
    }
  }
`;

const REPOSITORY_EXISTS_QUERY = /* GraphQL */ `
  query RepositoryExists($slug: String!, $organizationId: UUID) {
    repositories(
      filter: {
        slug: { equalTo: $slug }
        organizationId: { equalTo: $organizationId }
      }
      first: 1
    ) {
      nodes {
        rowId
        slug
      }
    }
  }
`;

// Arbor stores no organization name or slug: those are resolved from IDP
// claims at runtime, so an organization is only addressable here by id. Hence
// --list-orgs, which prints what the session token can see so the right id can
// be picked, rather than a --org <slug> that cannot be resolved
const ORGANIZATIONS_QUERY = /* GraphQL */ `
  query Organizations {
    organizations(first: 100) {
      nodes {
        rowId
        idpOrganizationId
        description
      }
    }
  }
`;

// The auto-generated createRepository is deliberately NOT used: it inserts the
// row without initializing git storage on disk, producing a repository that
// cannot be cloned or pushed to
const CREATE_REPOSITORY_MUTATION = /* GraphQL */ `
  mutation CreateRepositoryWithGit($input: CreateRepositoryWithGitInput!) {
    createRepositoryWithGit(input: $input) {
      rowId
      slug
      ownerUsername
      organizationSlug
      error
    }
  }
`;

interface Options {
  apply: boolean;
  listOrgs: boolean;
  orgId: string | null;
  visibility: "public" | "private" | null;
  addRemote: string | null;
  api: string;
  gitHost: string;
  repos: string[];
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    apply: false,
    listOrgs: false,
    orgId: null,
    visibility: null,
    addRemote: null,
    api: "https://api.arbor.omni.dev",
    gitHost: "git.arbor.omni.dev",
    repos: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--list-orgs":
        options.listOrgs = true;
        break;
      case "--org-id":
        options.orgId = argv[++i] ?? null;
        break;
      case "--visibility": {
        const value = argv[++i];
        if (value !== "public" && value !== "private") {
          throw new Error("--visibility must be public or private");
        }
        options.visibility = value;
        break;
      }
      case "--add-remote":
        options.addRemote = argv[++i] ?? null;
        break;
      case "--api":
        options.api = argv[++i] ?? options.api;
        break;
      case "--git-host":
        options.gitHost = argv[++i] ?? options.gitHost;
        break;
      default:
        if (arg?.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        if (arg) options.repos.push(arg);
    }
  }

  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  const sessionToken = process.env.ARBOR_SESSION_TOKEN;
  const pat = process.env.ARBOR_PAT;

  if (!sessionToken) {
    console.error(
      "ARBOR_SESSION_TOKEN not set (IDP session token; required to create repositories)",
    );
    process.exit(1);
  }
  if (!pat && options.apply) {
    console.error("ARBOR_PAT not set (required to push)");
    process.exit(1);
  }

  if (options.listOrgs) {
    const data = await graphql(
      options.api,
      sessionToken,
      ORGANIZATIONS_QUERY,
      {},
    );
    const nodes =
      (
        data.organizations as
          | {
              nodes?: {
                rowId: string;
                idpOrganizationId: string;
                description: string | null;
              }[];
            }
          | undefined
      )?.nodes ?? [];

    if (nodes.length === 0) {
      console.log("No organizations visible to this session token.");
      return;
    }

    console.log("Pass one of these to --org-id:\n");
    for (const node of nodes) {
      console.log(
        `  ${node.rowId}  idp=${node.idpOrganizationId}${
          node.description ? `  ${node.description}` : ""
        }`,
      );
    }
    return;
  }

  if (options.repos.length === 0) {
    console.error(
      "usage: bun scripts/migrate.ts [--apply] [--org-id <rowId>] <owner/repo...>",
    );
    console.error("       bun scripts/migrate.ts --list-orgs");
    process.exit(1);
  }

  if (!options.apply) {
    console.log("DRY RUN. Nothing will be created or pushed. Pass --apply.\n");
  }

  const organizationId = options.orgId;

  // Resolve the acting user's Arbor username, the owner segment of every clone
  // URL this run produces
  const observer = await graphql(options.api, sessionToken, OBSERVER_QUERY, {});
  const observerRowId = (
    observer.observer as { rowId?: string } | null | undefined
  )?.rowId;
  if (!observerRowId) {
    console.error("Could not resolve the current user; is the session token valid?");
    process.exit(1);
  }

  const userData = await graphql(options.api, sessionToken, USERNAME_QUERY, {
    id: observerRowId,
  });
  const arborOwner = (
    userData.users as { nodes?: { username: string }[] } | undefined
  )?.nodes?.[0]?.username;
  if (!arborOwner) {
    console.error("Could not resolve the current user's Arbor username");
    process.exit(1);
  }

  console.log(
    `Acting as ${arborOwner}${organizationId ? ` (org ${organizationId})` : ""}\n`,
  );

  let failures = 0;

  for (const input of options.repos) {
    const spec = parseRepoSpec(input);
    if (!spec) {
      console.error(`skip  ${input} (not owner/repo)`);
      failures++;
      continue;
    }

    const slug = toSlug(spec.name);
    const label = `${spec.owner}/${spec.name}`;

    try {
      // Mirror GitHub's visibility unless overridden
      let visibility = options.visibility;
      if (!visibility) {
        const raw = await run([
          "gh",
          "repo",
          "view",
          label,
          "--json",
          "visibility",
        ]);
        const parsed = JSON.parse(raw) as { visibility: string };
        visibility = parsed.visibility.toLowerCase() === "public"
          ? "public"
          : "private";
      }

      // Create the repository unless it is already there
      const existing = await graphql(
        options.api,
        sessionToken,
        REPOSITORY_EXISTS_QUERY,
        { slug, organizationId },
      );
      const alreadyExists =
        ((existing.repositories as { nodes?: unknown[] } | undefined)?.nodes
          ?.length ?? 0) > 0;

      if (alreadyExists) {
        console.log(`exists ${label} -> ${slug}`);
      } else if (options.apply) {
        const created = await graphql(
          options.api,
          sessionToken,
          CREATE_REPOSITORY_MUTATION,
          {
            input: {
              name: spec.name,
              slug,
              visibility,
              organizationId,
            },
          },
        );
        const payload = created.createRepositoryWithGit as {
          error?: string | null;
        } | null;
        if (payload?.error) throw new Error(payload.error);
        console.log(`create ${label} -> ${slug} (${visibility})`);
      } else {
        console.log(`create ${label} -> ${slug} (${visibility}) [dry run]`);
      }

      // Mirror push. A bare mirror clone is fetched into a temp dir so the
      // user's working copies are never touched
      const cloneUrl = arborCloneUrl(options.gitHost, arborOwner, slug);

      if (options.apply) {
        const workdir = `/tmp/arbor-migrate/${spec.owner}-${slug}.git`;
        await run(["rm", "-rf", workdir]);
        await run([
          "git",
          "clone",
          "--mirror",
          `https://github.com/${label}.git`,
          workdir,
        ]);

        const authed = cloneUrl.replace(
          "https://",
          `https://x-access-token:${pat}@`,
        );
        await run(["git", "push", "--mirror", authed], { cwd: workdir });

        // Verify parity rather than trusting the push's exit code
        const sourceRefs = parseLsRemote(
          await run(["git", "ls-remote", `https://github.com/${label}.git`]),
        );
        const destRefs = parseLsRemote(
          await run(["git", "ls-remote", authed]),
        );
        const diff = diffRefs(sourceRefs, destRefs);

        if (!diff.inSync) {
          throw new Error(
            `ref mismatch: ${diff.missing.length} missing, ${diff.mismatched.length} mismatched`,
          );
        }

        console.log(`push   ${label} -> ${cloneUrl} (${sourceRefs.size} refs verified)`);
        await run(["rm", "-rf", workdir]);
      } else {
        console.log(`push   ${label} -> ${cloneUrl} [dry run]`);
      }

      // Dual-remote: point the local clone at Arbor alongside origin
      if (options.addRemote) {
        const repoPath = `${options.addRemote}/${spec.name}`;
        if (options.apply) {
          await run(["git", "remote", "remove", "arbor"], {
            cwd: repoPath,
          }).catch(() => {});
          await run(["git", "remote", "add", "arbor", cloneUrl], {
            cwd: repoPath,
          });
          console.log(`remote ${repoPath} -> arbor`);
        } else {
          console.log(`remote ${repoPath} -> arbor [dry run]`);
        }
      }
    } catch (err) {
      failures++;
      console.error(
        `FAIL   ${label}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} repository/repositories failed`);
    process.exit(1);
  }

  console.log("\nDone.");
};

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // Surface a readable message rather than a stack trace: the common failures
    // here are an expired session token or a typo'd repo name
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
