#!/usr/bin/env bash
# Deploy to AWS Amplify Hosting using a *manual deployment* (zip upload).
# No Git connection, no build container, so no build minutes are billed - the cheapest way to use Amplify.
# Needs: AWS CLI v2, zip, curl, and AWS credentials (env vars, a profile, or an assumed role).
#   ./infra/deploy.sh                       # app "whats-that-plane", branch "main", us-east-1
#   APP_NAME=x BRANCH=y AWS_REGION=z ./infra/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-whats-that-plane}"
BRANCH="${BRANCH:-main}"
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_PAGER=""

# --- 1. app (create once, reuse afterwards) ---------------------------------------------------------
APP_ID="$(aws amplify list-apps --query "apps[?name=='$APP_NAME'].appId | [0]" --output text)"
if [[ -z "$APP_ID" || "$APP_ID" == "None" ]]; then
  echo "▸ creating Amplify app $APP_NAME"
  APP_ID="$(aws amplify create-app --name "$APP_NAME" --platform WEB \
      --description "What's That Plane? - AR flight tracker (manual deploys, no builds)" \
      --custom-headers "$(cat infra/custom-headers.yml)" \
      --custom-rules file://infra/custom-rules.json \
      --query 'app.appId' --output text)"
else
  echo "▸ using Amplify app $APP_NAME ($APP_ID)"
  aws amplify update-app --app-id "$APP_ID" --custom-headers "$(cat infra/custom-headers.yml)" \
      --custom-rules file://infra/custom-rules.json >/dev/null
fi

# --- 2. branch ----------------------------------------------------------------------------------------
if ! aws amplify get-branch --app-id "$APP_ID" --branch-name "$BRANCH" >/dev/null 2>&1; then
  echo "▸ creating branch $BRANCH"
  aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" --stage PRODUCTION \
    --enable-auto-build false >/dev/null
fi

# --- 3. zip just the site files (index.html must be at the zip root) ---------------------------------
ZIP="$(mktemp -t site.XXXXXX).zip"
zip -q -j "$ZIP" index.html app.js style.css manifest.webmanifest icon.svg icon-192.png icon-512.png
echo "▸ bundle: $(du -h "$ZIP" | cut -f1)"

# --- 4. upload + deploy --------------------------------------------------------------------------------
read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
    --query '[jobId, zipUploadUrl]' --output text)
curl -sS -f -T "$ZIP" "$UPLOAD_URL"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" >/dev/null
rm -f "$ZIP"

echo -n "▸ deploying job $JOB_ID "
for _ in $(seq 1 60); do
  STATUS="$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" \
      --query 'job.summary.status' --output text)"
  case "$STATUS" in
    SUCCEED) echo "✓"; break ;;
    FAILED|CANCELLED) echo; echo "deployment $STATUS"; exit 1 ;;
    *) echo -n "."; sleep 5 ;;
  esac
done

DOMAIN="$(aws amplify get-app --app-id "$APP_ID" --query 'app.defaultDomain' --output text)"
echo
echo "✅  https://$BRANCH.$DOMAIN/"
