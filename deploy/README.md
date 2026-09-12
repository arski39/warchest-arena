# Deploying this fork

Single box, Docker, Caddy, Cloudflare in front of the apex. Written for
`warchest-arena.com` on an Oracle Cloud A1.Flex (ARM64), but nothing here is
specific to that host beyond the hostnames in `Caddyfile`.

**None of upstream's four scripts work here** and they are not patched — the
reasons are in the header of `warchest.sh`. This directory replaces them.

| File                   | What                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `warchest.sh`          | Build natively, swap both containers behind a health gate, roll back on failure |
| `Caddyfile`            | TLS from a Cloudflare Origin Certificate; routes apex → game, `api.` → auth     |
| `warchest.env.example` | The runtime environment, with the traps documented inline                       |

## First deploy

```bash
# 1. state directory
sudo mkdir -p /opt/warchest && sudo chown ubuntu:ubuntu /opt/warchest

# 2. the match authority — generated HERE, never copied from anywhere
solana-keygen new --no-bip39-passphrase -o /opt/warchest/arena-authority.json
chmod 600 /opt/warchest/arena-authority.json
solana address -k /opt/warchest/arena-authority.json # fund this with SOL

# 3. the code
git clone https://github.com/arski39/warchest-arena.git /opt/warchest/app
cd /opt/warchest/app

# 4. the environment
cp deploy/warchest.env.example /opt/warchest/warchest.env
chmod 600 /opt/warchest/warchest.env
$EDITOR /opt/warchest/warchest.env

# 5. TLS — paste the Cloudflare Origin cert and key
sudo mkdir -p /etc/caddy/certs && sudo chmod 700 /etc/caddy/certs
sudo $EDITOR /etc/caddy/certs/origin.pem
sudo $EDITOR /etc/caddy/certs/origin.key
sudo chmod 600 /etc/caddy/certs/origin.key

# 6. Caddy
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 7. the auth signing key — ONCE, after the first image build
#    (build first with --no-build omitted, then generate, then redeploy)

# 8. go
./deploy/warchest.sh
```

## Updating

```bash
cd /opt/warchest/app && git fetch origin && git reset --hard origin/arena-wip-snapshot && sudo ./deploy/warchest.sh
```

Both halves of that are load-bearing, and the shorter
`./deploy/warchest.sh --pull` fails on each:

- **`sudo`.** The script calls `docker` directly and never escalates itself.
  Docker is root-only on this box, so without it the deploy dies at the first
  container command — after it has already pulled and built.
- **`git fetch` + `git reset --hard`, not `--pull`.** `--pull` runs
  `git pull --ff-only`, which refuses the moment the box's checkout differs
  from the branch at all. It has: `warchest.sh`'s file mode and its line
  endings have both drifted here. A reset is unconditional, and nothing on
  that box is worth keeping — it is a deploy checkout, not a place anyone
  edits.

`--pull` stays in the script because it is right for a checkout that has never
drifted. It is not the command to reach for here.

The previous image is retained as `warchest:previous`, so `--rollback` works
until the _next_ successful build overwrites it.

## What the health gate actually checks

**`/api/health` alone is not a smoke test, and this is the sharpest trap in the
whole deployment.** It returns `200` as soon as the workers register, and keeps
returning `200` when `TURNSTILE_SITE_KEY`, `GIT_COMMIT`, `DOMAIN` or
`NUM_WORKERS` is missing and **every `GET /` is returning 500** — because
`RenderHtml.ts` reads all four while building its EJS data object, long after
the health route is up. A monitor watching only `/api/health` will report a
healthy site that nobody can load.

So the gate asserts both: `/api/health` is 200 **and** `/` returns markup.

Connection-refused in the first seconds is expected, not a failure — the master
binds `:3000` only _after_ `runWagerPreflight()`, which makes live Solana RPC
round-trips with no explicit timeout.

## What the arena log check catches

When wagering is configured, the script then reads the boot log, because the
counts are the diagnostic:

- **`wagering enabled and verified` must appear `NUM_WORKERS + 1` times** —
  master plus every worker. Fewer means a worker died before preflight.
- **`[arena/sweeper] recovering orphaned escrows` must appear exactly once**,
  from the master. Present in the workers but missing from the master is the
  master/worker dotenv trap (see `CLAUDE.md`), and its consequence is precise:
  the _only_ crash-recovery path for live escrows is silently disabled.
- **No `[arena/devBypass]` line at all.** Any is a refusal.

## Deliberate differences from `update.sh`

|                                        | Why                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No R2 asset upload                     | It POSTs to `api.$DOMAIN/game_assets/check`, an endpoint of upstream's **closed** API that `src/auth/routes.ts` does not implement. It 404s and `exit 1`s. `CDN_BASE=""` serves the same bytes same-origin. |
| No Traefik labels, publish to loopback | The Dockerfile has no `EXPOSE`; upstream relied on Traefik joining a shared network.                                                                                                                        |
| `--restart=always` unconditionally     | `update.sh` sets `RESTART=no` unless `SUBDOMAIN=main`. A wagering server that stays down leaves live escrows with nothing to settle or refund them, and the sweeper only runs while the process does.       |
| No `docker image prune -a -f`          | It runs box-wide and deletes any image not backing a _running_ container — including the build cache and the rollback target, on a box that builds locally.                                                 |
| Health gate + rollback                 | `update.sh`'s swap is stop → `sleep 5` → rm, with no gate and no way back.                                                                                                                                  |
| Built natively, no `--platform`        | esbuild picks its platform binary from the **build host's** arch, so an amd64 build produces an image whose bundler cannot run on ARM.                                                                      |

The one thing kept verbatim in spirit is `update.sh`'s **secret bind-mount
pattern** (`update.sh:222-240`): keys are mounted read-only at `/run/secrets/`
and only their in-container _paths_ are environment variables. A key in an env
var lands in `docker inspect`, in `ps`, and in any crash dump that prints the
environment.
