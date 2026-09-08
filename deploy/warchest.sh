#!/usr/bin/env bash
# [ARENA] Fork deploy script. Runs ON the target box, from a checkout of this
# repo. Builds the image natively and swaps both containers behind a health
# gate, with a rollback.
#
# WHY THIS EXISTS RATHER THAN A PATCH TO THE SHIPPED SCRIPTS
#
# All four of upstream's are unusable here, and not marginally:
#
#   deploy.sh  exits before doing anything -- it validates its host argument
#              against a hardcoded falk2|nbg1|staging|masters allowlist.
#   update.sh  can never reach the container swap. Its R2 asset-upload block is
#              unconditional and POSTs to api.$DOMAIN/game_assets/check, an
#              endpoint of upstream's CLOSED api that src/auth/routes.ts does
#              not implement. It 404s and the script exit 1s.
#   setup.sh   hard-requires Cloudflare origin cert/key AND OTel vars, and
#              builds a Traefik stack whose only entrypoint is :443 -- no :80,
#              so no ACME is possible anywhere in the repo.
#   build.sh   builds --platform linux/amd64 only, and insists on a registry
#              (--push); there is no local-build path.
#
# The one thing worth keeping is update.sh's secret-mount pattern, reproduced
# below with attribution.
#
# Usage:
#   ./deploy/warchest.sh                 build from the current checkout and swap
#   ./deploy/warchest.sh --pull          git pull first
#   ./deploy/warchest.sh --no-build      swap using the existing warchest:latest
#   ./deploy/warchest.sh --rollback      restore warchest:previous and stop
set -euo pipefail

# ---------------------------------------------------------------- configuration
STATE_DIR="${WARCHEST_STATE_DIR:-/opt/warchest}"
ENV_FILE="${WARCHEST_ENV_FILE:-$STATE_DIR/warchest.env}"
IMAGE="warchest"
GAME_CONTAINER="warchest"
AUTH_CONTAINER="warchest-auth"
GAME_PORT="${WARCHEST_GAME_PORT:-8080}"   # host side; nginx listens on 80 inside
AUTH_PORT_HOST="${WARCHEST_AUTH_PORT:-8787}"
# 180 was too tight and failed a deploy that had in fact succeeded. Readiness
# needs EVERY worker to report in once, and each of the NUM_WORKERS+1 processes
# runs runWagerPreflight() first -- live Solana RPC round-trips, against an
# endpoint that rate-limits. The rollback that follows a false negative is far
# more disruptive than waiting.
HEALTH_TIMEOUT_SECS="${WARCHEST_HEALTH_TIMEOUT:-420}"

# The container runs node as uid 1000 (supervisord.conf `user=node`). A
# 600 root-owned key mounts fine and is then unreadable inside, which surfaces
# as a preflight failure rather than as a mount error.
CONTAINER_UID=1000

DO_BUILD=1
DO_PULL=0
DO_ROLLBACK=0
for arg in "$@"; do
    case "$arg" in
        --pull)     DO_PULL=1 ;;
        --no-build) DO_BUILD=0 ;;
        --rollback) DO_ROLLBACK=1 ;;
        -h|--help)  sed -n '1,29p' "$0"; exit 0 ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------- helpers

# Docker silently creates a *directory* for a bind source that does not exist,
# and that surfaces much later as an unreadable key rather than a failed deploy.
check_secret() {
    local path="$1" label="$2" uid mode
    [ -f "$path" ] || die "$label is $path, which is not a file on this host."
    uid="$(stat -c '%u' "$path")"
    mode="$(stat -c '%a' "$path")"
    # uid 1000 inside the container is `node`. Do NOT assume your login user is
    # uid 1000 -- on the Oracle Ubuntu image `ubuntu` is 1001 and `opc` is 1000,
    # so a key created by the logged-in user is mode 600 and owned by the WRONG
    # uid, and the container cannot read it. Check, do not guess.
    if [ "$uid" != "$CONTAINER_UID" ] && [ "${mode: -1}" -lt 4 ]; then
        die "$path is owned by uid $uid with mode $mode — the container's node user (uid $CONTAINER_UID) cannot read it.
    Fix: sudo chown $CONTAINER_UID:$CONTAINER_UID '$path' && sudo chmod 600 '$path'"
    fi
    ok "$label readable by uid $CONTAINER_UID (uid $uid, mode $mode)"
}

# Builds the derived env file used by `docker run --env-file`.
#
# Derived, because SERVER_KEYPAIR_PATH is an *in-container* path this script
# knows and the operator's file cannot. Docker copies the environment into the
# container config at create time, so this file can be deleted immediately
# after -- and is, because it is the one place everything sits together.
#
# Note this file is how GAME_ENV reaches the process. It cannot come from a
# .env the app parses itself: ServerEnv reads it in a static field initializer
# at module import, and Server.ts calls dotenv.config() after its imports.
write_runtime_env() {
    RUNTIME_ENV="$(mktemp)"
    chmod 600 "$RUNTIME_ENV"
    grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -v '^[[:space:]]*$' > "$RUNTIME_ENV"
    if [ -n "${ARENA_AUTHORITY_KEYPAIR:-}" ]; then
        echo "SERVER_KEYPAIR_PATH=/run/secrets/arena-authority.json" >> "$RUNTIME_ENV"
    fi
}

start_containers() {
    local tag="$1"
    local game_mounts=() auth_mounts=()

    # Secrets reach the containers as read-only bind mounts, never as env vars:
    # an env var lands in `docker inspect`, in `ps`, and in any crash dump that
    # prints the environment. Only the path is a variable, and this script sets
    # it, because a host path means nothing inside a container.
    # (Pattern kept from update.sh:222-240.)
    if [ -n "${ARENA_AUTHORITY_KEYPAIR:-}" ]; then
        game_mounts=(-v "${ARENA_AUTHORITY_KEYPAIR}:/run/secrets/arena-authority.json:ro")
    fi
    if [ -n "${AUTH_SIGNING_KEY:-}" ]; then
        auth_mounts=(-v "${AUTH_SIGNING_KEY}:/run/secrets/auth-signing-key.json:ro")
    fi

    # --restart=always unconditionally. update.sh sets RESTART=no unless
    # SUBDOMAIN=main, which is wrong for us in a specific way: a wagering server
    # that stays down after a crash leaves live escrows with nothing to settle
    # or refund them, and the recovery sweeper only runs while the process does.
    if [ -n "${AUTH_SIGNING_KEY:-}" ]; then
        # Same image, different entrypoint -- so no nginx and no supervisord run
        # in this one; it is a bare Node process.
        docker run -d --name "$AUTH_CONTAINER" --restart=always \
            --env-file "$RUNTIME_ENV" \
            -e AUTH_SIGNING_KEY_PATH=/run/secrets/auth-signing-key.json \
            "${auth_mounts[@]}" \
            -p "127.0.0.1:${AUTH_PORT_HOST}:${AUTH_PORT:-8787}" \
            --entrypoint npm "$IMAGE:$tag" run start:auth >/dev/null
    fi

    # The Dockerfile has no EXPOSE -- upstream relied on Traefik joining a
    # shared docker network. We publish to loopback and let Caddy reach it.
    docker run -d --name "$GAME_CONTAINER" --restart=always \
        --env-file "$RUNTIME_ENV" \
        "${game_mounts[@]}" \
        -p "127.0.0.1:${GAME_PORT}:80" \
        "$IMAGE:$tag" >/dev/null
}

swap_to() {
    docker rm -f "$GAME_CONTAINER" "$AUTH_CONTAINER" >/dev/null 2>&1 || true
    start_containers "$1"
}

# Reads the env file the way `docker run --env-file` does: plain KEY=VALUE
# lines, no shell evaluation, no quote stripping.
#
# NOT `.` / `source`. The file legitimately contains `SITE_NAME=Warchest Arena`,
# and sourcing that runs `Arena` as a command. Quoting the value in the file
# would fix the sourcing and break the container instead, because docker's
# --env-file does not strip quotes -- the site name would come out with the
# quotes in it. Parsing here is the only version where both readers agree.
load_env() {
    [ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Copy deploy/warchest.env.example and fill it in."
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; esac
        case "$line" in *=*) ;; *) continue ;; esac
        key=${line%%=*}
        val=${line#*=}
        # Ignore anything that is not a plain shell-safe name, rather than
        # trying to interpret it.
        case "$key" in
            [A-Za-z_]*) ;;
            *) continue ;;
        esac
        printf -v "$key" '%s' "$val"
        export "${key?}"
    done < "$ENV_FILE"
}

# ------------------------------------------------------------------- rollback
if [ "$DO_ROLLBACK" = 1 ]; then
    docker image inspect "$IMAGE:previous" >/dev/null 2>&1 \
        || die "no $IMAGE:previous image to roll back to"
    load_env
    write_runtime_env
    trap 'rm -f "${RUNTIME_ENV:-}"' EXIT
    say "Rolling back to $IMAGE:previous"
    swap_to previous
    ok "rolled back — health was NOT re-gated, check the site yourself"
    exit 0
fi

# --------------------------------------------------------------- sanity checks
say "Checking the environment"
load_env

# The four that produce a 500 on every GET / rather than a boot failure --
# RenderHtml.ts builds its EJS data object from all of them before rendering,
# and /api/health keeps returning 200 the whole time.
for v in GAME_ENV NUM_WORKERS TURNSTILE_SITE_KEY DOMAIN; do
    if [ -z "${!v:-}" ]; then
        die "$v is not set in $ENV_FILE. Without it every GET / returns 500 while /api/health still says ok."
    fi
done
case "$GAME_ENV" in
    dev|staging|prod) ;;
    *) die "GAME_ENV must be dev, staging or prod (got \"$GAME_ENV\"). Anything else throws at module import, with no 'Failed to start server' line to explain it." ;;
esac
ok "GAME_ENV=$GAME_ENV  NUM_WORKERS=$NUM_WORKERS  DOMAIN=$DOMAIN"

# ARENA_DEV_BYPASS skips the wallet-signature session binding and the on-chain
# stake check. It is cluster-gated at runtime too, but there is no reason for it
# to be anywhere near a deploy.
if [ "${ARENA_DEV_BYPASS:-}" = "true" ]; then
    die "ARENA_DEV_BYPASS=true in $ENV_FILE. Never on a public site."
fi

# Wagering is opt-in; an empty program id is a supported free-to-play mode, not
# a mistake. A half-configured one is.
WAGERING=0
if [ -n "${ARENA_PROGRAM_ID:-}" ]; then
    WAGERING=1
    if [ -z "${ARENA_STAKE_MINT:-}" ]; then
        die "ARENA_PROGRAM_ID is set but ARENA_STAKE_MINT is not — preflight refuses and every lobby stays free to play."
    fi
    if [ -z "${ARENA_AUTHORITY_KEYPAIR:-}" ]; then
        die "ARENA_PROGRAM_ID is set but ARENA_AUTHORITY_KEYPAIR is not — there is no authority to create matches or sign results."
    fi
    if [ "${ARENA_RAKE_BPS:-0}" != "0" ] && [ -z "${TREASURY_TOKEN_ACCOUNT:-}" ]; then
        die "ARENA_RAKE_BPS=${ARENA_RAKE_BPS} but TREASURY_TOKEN_ACCOUNT is unset — settlement would refuse and leave the pot in escrow."
    fi
    ok "wagering configured (rake ${ARENA_RAKE_BPS:-0} bps)"
else
    warn "ARENA_PROGRAM_ID is empty — deploying with wagering disabled, every lobby free to play"
fi

if [ -n "${ARENA_AUTHORITY_KEYPAIR:-}" ]; then
    check_secret "$ARENA_AUTHORITY_KEYPAIR" ARENA_AUTHORITY_KEYPAIR
fi
if [ -n "${AUTH_SIGNING_KEY:-}" ]; then
    check_secret "$AUTH_SIGNING_KEY" AUTH_SIGNING_KEY
else
    warn "AUTH_SIGNING_KEY unset — no auth container will run, and the site only works with GAME_ENV=dev"
fi

# ------------------------------------------------------------------- the build
if [ "$DO_PULL" = 1 ]; then
    say "Pulling"
    git pull --ff-only
fi

GIT_COMMIT="$(git rev-parse HEAD)"

if [ "$DO_BUILD" = 1 ]; then
    say "Building $IMAGE:latest for $(uname -m)"
    if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
        docker tag "$IMAGE:latest" "$IMAGE:previous"
        ok "kept the current image as $IMAGE:previous for rollback"
    else
        warn "no existing image — this deploy has no rollback target"
    fi

    # Built natively, never with --platform: esbuild selects its platform binary
    # from the BUILD HOST's arch, so an amd64 build produces an image whose
    # bundler binary cannot run here.
    #
    # GIT_COMMIT is not decoration. ServerEnv.gitCommit() throws without it, and
    # that throw surfaces as a 500 on every GET /, not as a boot failure.
    docker build --build-arg GIT_COMMIT="$GIT_COMMIT" -t "$IMAGE:latest" .
    ok "built $GIT_COMMIT"
else
    docker image inspect "$IMAGE:latest" >/dev/null 2>&1 \
        || die "--no-build, but there is no $IMAGE:latest to run"
fi

# ------------------------------------------------------------------ the runtime
write_runtime_env
trap 'rm -f "${RUNTIME_ENV:-}"' EXIT

say "Swapping containers"
swap_to latest
ok "started"

# -------------------------------------------------------------- the health gate
# Two assertions, because one of them lies.
#
# /api/health returns 200 as soon as the workers register, and KEEPS returning
# 200 when TURNSTILE_SITE_KEY / GIT_COMMIT / DOMAIN / NUM_WORKERS is missing and
# every GET / is 500ing. A health check alone will tell you the site is fine
# while the site is entirely down. So we also fetch / and look for markup.
#
# Connection-refused early on is expected, not a failure: the master binds :3000
# only AFTER runWagerPreflight(), which makes live Solana RPC round-trips.
say "Waiting for health (up to ${HEALTH_TIMEOUT_SECS}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${GAME_PORT}/api/health" >/dev/null 2>&1 \
       && curl -fsS --max-time 10 "http://127.0.0.1:${GAME_PORT}/" 2>/dev/null | grep -qi '<html'; then
        healthy=1
        break
    fi
    sleep 3
done

if [ "$healthy" != 1 ]; then
    warn "health gate failed — last 60 log lines:"
    docker logs --tail 60 "$GAME_CONTAINER" 2>&1 | sed 's/^/      /'
    if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
        warn "rolling back to $IMAGE:previous"
        swap_to previous
        die "deploy failed and was rolled back. The new image is still tagged $IMAGE:latest for inspection."
    fi
    die "deploy failed and there is no previous image to roll back to. Containers are left running for inspection."
fi
ok "/api/health is 200 and / serves markup"

# ------------------------------------------- the boot log is the real arena check
# preflight and stakeMint run per process -- master plus each worker -- and the
# sweeper is master-only. The counts are the diagnostic:
#
#   fewer preflight lines than NUM_WORKERS+1
#     -> a worker died before preflight
#   preflight ok in the workers but no sweeper line
#     -> the master/worker dotenv trap (CLAUDE.md), whose consequence is that
#        the ONLY crash-recovery path for live escrows is silently disabled
if [ "$WAGERING" = 1 ]; then
    say "Checking the arena boot log"
    expected=$(( NUM_WORKERS + 1 ))
    verified=0
    for _ in $(seq 1 20); do
        verified="$(docker logs "$GAME_CONTAINER" 2>&1 | grep -c 'wagering enabled and verified' || true)"
        if [ "$verified" -ge "$expected" ]; then break; fi
        sleep 3
    done
    sweeper="$(docker logs "$GAME_CONTAINER" 2>&1 | grep -c 'recovering orphaned escrows' || true)"

    if [ "$verified" -lt "$expected" ]; then
        docker logs "$GAME_CONTAINER" 2>&1 | grep 'arena/' | sed 's/^/      /' || true
        die "preflight verified $verified times, expected $expected (master + $NUM_WORKERS workers). Wagering is not operational on every process."
    fi
    ok "preflight verified ${verified}x (master + $NUM_WORKERS workers)"

    if [ "$sweeper" -lt 1 ]; then
        die "no [arena/sweeper] line. The master disagrees with its workers — see the master/worker dotenv trap in CLAUDE.md. Live escrows would have no recovery path."
    fi
    ok "sweeper running (master only)"

    if docker logs "$GAME_CONTAINER" 2>&1 | grep -q 'arena/devBypass'; then
        die "ARENA_DEV_BYPASS resolved as ENABLED. Refusing to leave this deployed."
    fi
    ok "no dev bypass"
fi

say "Deployed"
echo "    commit   $GIT_COMMIT"
echo "    game     http://127.0.0.1:${GAME_PORT}  ->  https://${DOMAIN}"
if [ -n "${AUTH_SIGNING_KEY:-}" ]; then
    echo "    auth     http://127.0.0.1:${AUTH_PORT_HOST}  ->  https://api.${DOMAIN}"
fi
cat <<EOF

    Public smoke test:
      curl -sS https://${DOMAIN} | head -c 200
      curl -sS https://api.${DOMAIN}/health
      docker exec ${GAME_CONTAINER} curl -sS https://api.${DOMAIN}/health   # the hairpin

    Rollback:  ./deploy/warchest.sh --rollback
EOF
