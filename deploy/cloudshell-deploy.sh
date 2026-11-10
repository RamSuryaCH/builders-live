#!/usr/bin/env bash
# One-command deploy from AWS CloudShell. Region is always ap-southeast-2.
# The host PIN and budget email are asked for here. They are not stored in git.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_DEFAULT_REGION=ap-southeast-2
STACK="${STACK_NAME:-builders-live}"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials are not available. Open this repo in AWS CloudShell and run the script again."
  exit 1
fi

REGION="$(aws configure get region || true)"
if [[ -n "${AWS_DEFAULT_REGION}" && "${AWS_DEFAULT_REGION}" != "ap-southeast-2" ]]; then
  echo "Refusing to deploy outside ap-southeast-2."
  exit 1
fi

if [[ -z "${ADMIN_SECRET:-}" ]]; then
  read -r -s -p "Host PIN (8 or more characters): " ADMIN_SECRET
  echo
fi
if [[ -z "${BUDGET_EMAIL:-}" ]]; then
  read -r -p "Budget alert email: " BUDGET_EMAIL
fi

python3 - "$ADMIN_SECRET" "$BUDGET_EMAIL" <<'PY'
import re, sys
secret, email = sys.argv[1], sys.argv[2]
if not re.fullmatch(r"[A-Za-z0-9!@#%^*+=._~-]{8,72}", secret):
    sys.exit("Host PIN must be 8-72 characters and use letters, numbers, or simple symbols.")
if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
    sys.exit("Budget email does not look like an email address.")
PY

if ! command -v sam >/dev/null 2>&1; then
  echo "Installing AWS SAM CLI for this CloudShell session..."
  python3 -m pip install --user aws-sam-cli
  export PATH="${HOME}/.local/bin:${PATH}"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is required. In CloudShell, install Node.js 20 or newer, then run this script again."
  exit 1
fi

npm ci
npm run build:server
sam build --template infra/template.yaml

CFG="$(mktemp)"
trap 'rm -f "$CFG"' EXIT
python3 - "$CFG" "$STACK" "$ADMIN_SECRET" "$BUDGET_EMAIL" <<'PY'
import sys
path, stack, secret, email = sys.argv[1:]
overrides = " ".join([
    f"AdminSecret={secret}",
    f"BudgetAlertEmail={email}",
    "EnableBedrockSummary=false",
])
open(path, "w").write(f"""version = 0.1
[default.deploy.parameters]
stack_name = "{stack}"
region = "ap-southeast-2"
capabilities = "CAPABILITY_IAM CAPABILITY_NAMED_IAM"
confirm_changeset = false
fail_on_empty_changeset = false
resolve_s3 = true
parameter_overrides = "{overrides}"
""")
PY
chmod 600 "$CFG"
sam deploy --config-file "$CFG" --template-file .aws-sam/build/template.yaml --no-confirm-changeset

read_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region ap-southeast-2 \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
DOMAIN="$(read_output CloudFrontDomain)"
BUCKET="$(read_output FrontendBucketName)"
DIST="$(read_output DistributionId)"
WS="$(read_output WebSocketUrl)"
SITE="https://${DOMAIN}"

PUBLIC_BASE_URL="$SITE" VITE_WS_URL="$WS" npm run build:web
aws s3 sync frontend/dist "s3://${BUCKET}" --delete --region ap-southeast-2
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null

echo
echo "Builders Live is deploying to the edge."
echo "Site:     ${SITE}"
echo "Host:     ${SITE}/host"
echo "Realtime: ${WS}"
echo "AWS will email ${BUDGET_EMAIL} to confirm the 5 USD budget alert."
echo "CloudFront can take a few minutes before the first open works."
