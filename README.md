# Reoclo Load Secrets (`@reoclo/load-secrets`)

Load secrets from the [Reoclo](https://reoclo.com) Secrets Manager into your GitHub Actions environment. Later steps read them as ordinary environment variables.

Keep your secrets in the Reoclo Secrets Manager and read them at run time with one scoped automation key. You do not copy every secret into GitHub Secrets, and you keep one source of truth.

## Why

- **One source of truth.** Secrets stay in the Reoclo Secrets Manager. CI reads them and never stores them.
- **Scoped access.** An automation key reads only the secret projects you grant it.
- **Audited.** Each load opens a session that records the repository, the commit, and the workflow run id.
- **Masked.** The action registers every value as a secret with the runner, so the log shows `***`.
- **Works with the other actions.** Pair it with [`reoclo/run`](https://github.com/reoclo/run), [`reoclo/checkout`](https://github.com/reoclo/checkout), and [`reoclo/docker-auth`](https://github.com/reoclo/docker-auth) for a full deploy workflow.

## Quick start

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Load secrets
        uses: reoclo/load-secrets@v1
        with:
          api_key: ${{ secrets.REOCLO_AUTOMATION_KEY }}

      - name: Use them
        run: ./run-migrations.sh   # DB_URL, API_TOKEN, ... are now env vars, masked in logs
```

Each secret **key** in your granted projects becomes an **environment variable name**. By default the action loads every project you grant the key. Use `projects` to load a subset.

## Setup

1. In the Reoclo dashboard, create an **Automation Key** and enable the **Read secrets** operation.
2. Grant that key each secret **project** it must read. Open the project **Access** tab and add the grant.
3. Add the key to your repository as a GitHub Actions secret named `REOCLO_AUTOMATION_KEY`.

The **Read secrets** operation alone grants no project. You must complete step 2.

If your repository already has a secret named `REOCLO_API_KEY`, keep it and pass it to `api_key`. The action reads `api_key` and calls the Reoclo API directly. It does not use a CLI or set `REOCLO_AUTOMATION_KEY`.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | yes | - | Reoclo automation key (`rca_...`). A session key (`rss_...`) also works. |
| `projects` | no | *(all granted)* | Secret project names or ids, one per line or comma-separated. |
| `prefix` | no | `''` | Prefix added to every loaded environment variable name. |
| `cleanup` | no | `true` | Unset the loaded secrets at job end in a post-step. |
| `commit` | no | `github.sha` | Commit SHA recorded in the audit trail. |
| `api_url` | no | `https://api.reoclo.com` | Reoclo API URL. Set it for a self-hosted Reoclo. |

## Outputs

| Output | Description |
|--------|-------------|
| `session_id` | Secrets session id for the audit trail. |
| `loaded_count` | Number of secrets loaded. |
| `loaded_keys` | Comma-separated names of the loaded variables. Names only, never values. |

## Examples

### Load only specific projects

```yaml
- uses: reoclo/load-secrets@v1
  with:
    api_key: ${{ secrets.REOCLO_AUTOMATION_KEY }}
    projects: |
      production-api
      shared-infra
```

### Add a prefix to every name

```yaml
- uses: reoclo/load-secrets@v1
  with:
    api_key: ${{ secrets.REOCLO_AUTOMATION_KEY }}
    prefix: APP_        # a secret keyed DB_URL loads as APP_DB_URL
```

### Feed a deploy on a Reoclo-managed server

```yaml
- uses: reoclo/load-secrets@v1
  with:
    api_key: ${{ secrets.REOCLO_AUTOMATION_KEY }}
    projects: production-api

- uses: reoclo/run@v2
  with:
    api_key: ${{ secrets.REOCLO_AUTOMATION_KEY }}
    server_id: ${{ secrets.REOCLO_SERVER_ID }}
    env: |
      DB_URL=${{ env.DB_URL }}
    command: ./deploy.sh
```

### Self-hosted Reoclo

```yaml
- uses: reoclo/load-secrets@v1
  with:
    api_key: ${{ secrets.REOCLO_AUTOMATION_KEY }}
    api_url: https://reoclo.example.com
```

## How it works

1. The action lists the secret projects you grant the key. If you set `projects`, it keeps only those.
2. It opens an audited session. The session records the commit and the workflow run id.
3. It resolves every secret in those projects to a name and value map, under a short-lived session token.
4. It masks each value and exports it to `$GITHUB_ENV` under its key, plus any `prefix`.
5. It sets `session_id`, `loaded_count`, and `loaded_keys` as outputs.

The action calls the Reoclo automation API over HTTPS. It downloads no CLI binary. It uses the same resolution and audit path as the `reoclo run` CLI command.

## Security notes

- **Masking.** The action registers every non-empty value as a secret before it exports the value. The runner then redacts the value in all later log output.
- **`$GITHUB_ENV` scope.** Loaded values reach every later step in the same job. GitHub per-job runner isolation keeps them out of other jobs.
- **Post-step cleanup.** With `cleanup: true` (the default), the action overwrites each loaded variable with an empty value at job end. This keeps plaintext out of later post-steps and job state. It does not scrub steps that already ran, and it does not replace masking.
- **Least privilege.** Use a separate key per environment. Grant each key only the projects that environment needs.

## Runtime requirements

This action runs on the **Node 24** runtime (`runs.using: node24`).

- **GitHub-hosted runners:** supported. Node 24 is the runner default since 2026-03-04 (runner v2.328.0 or newer).
- **Self-hosted runners:** the runner image must provide Node 24.
- Node 24 does not run on macOS 13.4 and older. Use `ubuntu-latest` or a newer macOS image.

## Gitea Actions

The action also runs on Gitea Actions. The Gitea runner image must provide Node 24.

## License

MIT
