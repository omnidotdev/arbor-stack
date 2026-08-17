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

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
