# 🌲 Arbor Metarepo

Arbor is a Git-powered code hosting and collaboration platform. This metarepo orchestrates the Arbor service stack for local development with [Tilt](https://tilt.dev) and Docker Compose.

## Services

| Service | Stack | Description |
|---------|-------|-------------|
| `arbor-api` | Bun / Elysia / Postgraphile | GraphQL API |
| `arbor-app` | TanStack Start | Web application |
| `arbor-git` | Rust / gRPC | High-performance Git backend (powered by gitoxide) |

## Prerequisites

- [Tilt](https://tilt.dev)
- [Docker](https://docs.docker.com/get-docker) (with Compose)
- [Bun](https://bun.sh) (for the migration tooling in `scripts/`)

## Getting Started

1. Copy the environment template and set the required secrets:

   ```sh
   cp .env.local.template .env
   ```

   `DB_PASSWORD` and `AUTH_SECRET` are required. `DB_PASSWORD` is embedded in
   `DATABASE_URL`, so it must be URL-safe (`openssl rand -hex 32`).

2. Copy the service configuration:

   ```sh
   cp services.yaml.template services.yaml
   ```

   Configure the services as needed. To disable a service, comment it out.
   Included services are cloned to `services/<service-name>` unless a `path`
   override is set.

3. Start the stack with Tilt (clones missing services and loads their nested
   `Tiltfile`s):

   ```sh
   tilt up
   ```

> [!WARNING]
> Services may have their own setup requirements (e.g. additional environment
> variables). Consult each service's README to satisfy its initial requirements.

> 💡 If nested repos are cloned within this metarepo and you open it in your IDE,
> directories may be marked as ignored due to `.gitignore` patterns. Open the
> services you want to work on in their own directory (e.g. a separate VS Code
> workspace unit) instead.

## Docker Compose

`compose.yaml` runs the full stack (Postgres, `arbor-git`, `arbor-api`,
`arbor-app`) from prebuilt production images:

```sh
docker compose up
```

To build from local source in `./services` instead of pulling images, layer the
dev override (requires the services to be cloned):

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

## Diagnostics

- Postgres reports readiness via a `pg_isready` healthcheck; the API waits on it
  before starting.
- `arbor-git` exposes gRPC on `50051` and HTTP on `8080` (`GIT_HTTP_PORT`).
- `arbor-api` serves on `4000` (GraphQL); `arbor-app` on `3000`.

Check service state:

```sh
docker compose ps
docker compose logs -f api
```

## Common Commands

| Command | Description |
|---------|-------------|
| `tilt up` | Start the full stack via Tilt |
| `tilt down` | Tear down Tilt resources |
| `docker compose up` | Run the stack from production images |
| `docker compose -f compose.yaml -f compose.dev.yaml up --build` | Build and run from local source |
| `bun scripts/migrate.ts --help` | Mirror GitHub repositories into Arbor (dry run by default) |

Full documentation lives at [docs.omni.dev/arbor](https://docs.omni.dev/arbor).

## Authenticating git (CI and agents)

Arbor serves git over HTTPS at `git.arbor.omni.dev`. There is no SSH endpoint,
so every clone, fetch, and push authenticates over HTTPS with a personal access
token (PAT). The Omni SSO account password is not a git credential and will not
authenticate a git operation; a PAT is required.

### Create a token

Create a PAT in the web app under [Settings -> Tokens](https://arbor.omni.dev/settings/tokens).
A token may be:

- **read** or **write** (a read token can clone and fetch but never push)
- **non-expiring** or limited to a lifetime in days
- **unconfined** (reaches every repository its owner can reach) or **confined**
  to named repositories, optionally down to specific ref and path globs (e.g.
  `refs/heads/agent/*`, `src/**`) for an agent that should only touch its own
  branches

The plaintext token is shown once at creation and never again; store it in the
caller's secret store immediately.

### Use the token with git

Git sends the token as the HTTP Basic password; the username is ignored, so any
placeholder works:

```sh
# clone
git clone https://arbor@git.arbor.omni.dev/<owner>/<repo>.git

# or inject the token directly (useful in CI, where no prompt is available)
git clone https://x:${ARBOR_PAT}@git.arbor.omni.dev/<owner>/<repo>.git
```

For an existing checkout, add Arbor as a remote and push to it:

```sh
git remote add arbor https://git.arbor.omni.dev/<owner>/<repo>.git
git push arbor master
```

### CI and agents

- **CI**: store the PAT as a masked secret and pass it as the Basic password, as
  in the `https://x:${ARBOR_PAT}@...` form above. A read-only token is enough for
  a pipeline that only needs to clone sources.
- **Agents**: the same PAT authenticates Arbor's first-party MCP server at
  `https://api.arbor.omni.dev/mcp` as a bearer token, so an agent drives
  repositories, pull requests, and checks through a supported surface rather
  than by scraping. See the [arbor-api README](services/arbor-api/README.md) for
  the MCP tool surface.

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
