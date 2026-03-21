#!/bin/bash
set -e

# ── Step 1: Project naming ──────────────────────────────
read -p "Project name (e.g. dobby): " PROJECT_NAME
read -p "Package scope (e.g. @suverenum): " SCOPE

# Validate inputs
if [[ ! "$PROJECT_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "❌ Invalid project name. Use only letters, numbers, hyphens, and underscores."
  exit 1
fi

if [[ ! "$SCOPE" =~ ^@[a-zA-Z0-9_-]+$ ]]; then
  echo "❌ Invalid scope. Must start with @ followed by letters, numbers, hyphens, or underscores."
  exit 1
fi

# Derive a display name from the project name (e.g. my-app -> My App)
DISPLAY_NAME=$(echo "$PROJECT_NAME" | sed 's/[-_]/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')

# Find-and-replace placeholders in text files only
find . -type f \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -path './bun.lock' \
  -not -name 'setup.sh' \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.md' \
     -o -name '*.yaml' -o -name '*.yml' -o -name '*.sh' -o -name '*.css' \
     -o -name '*.html' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \
     -o -name '*.cjs' -o -name '*.toml' -o -name '.env*' -o -name '.node-version' \
     -o -name '.gitkeep' -o -name '.gitignore' \) \
  -print0 | while IFS= read -r -d '' file; do
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/Template App/${DISPLAY_NAME}/g; s/@template/${SCOPE}/g; s/template-app/${PROJECT_NAME}/g" "$file"
  else
    sed -i "s/Template App/${DISPLAY_NAME}/g; s/@template/${SCOPE}/g; s/template-app/${PROJECT_NAME}/g" "$file"
  fi
done

echo "✅ Renamed to ${SCOPE}/${PROJECT_NAME}"

# ── Step 2: Vercel ────────────────────────────────────────
read -p "Set up Vercel project? (y/n): " SETUP_VERCEL

if [[ "$SETUP_VERCEL" == "y" ]]; then
  echo "Creating Vercel project..."
  vercel link --yes --project "$PROJECT_NAME"
  echo "✅ Vercel project created and linked"
fi

# ── Step 3: Neon database ────────────────────────────────
read -p "Create Neon database? (y/n): " SETUP_NEON

if [[ "$SETUP_NEON" == "y" ]]; then
  read -p "Neon org ID: " NEON_ORG_ID
  echo "Creating Neon project..."

  NEON_OUTPUT=$(neonctl projects create \
    --name "$PROJECT_NAME" \
    --org-id "$NEON_ORG_ID" \
    --region-id aws-us-east-1 \
    --output json)

  NEON_PROJECT_ID=$(echo "$NEON_OUTPUT" | jq -r '.id')

  # Create a named database (default is 'neondb')
  neonctl databases create \
    --project-id "$NEON_PROJECT_ID" \
    --name "$PROJECT_NAME" \
    --owner-name neondb_owner

  DATABASE_URL=$(neonctl connection-string \
    --project-id "$NEON_PROJECT_ID" \
    --database-name "$PROJECT_NAME" \
    --output json | jq -r '.connection_string')

  echo "✅ Neon database created"

  if [[ "$SETUP_VERCEL" == "y" ]]; then
    echo "$DATABASE_URL" | vercel env add DATABASE_URL production --force
    echo "$DATABASE_URL" | vercel env add DATABASE_URL preview --force
    echo "$DATABASE_URL" | vercel env add DATABASE_URL development --force
    echo "✅ DATABASE_URL added to Vercel (production + preview + development)"
  fi
fi

# ── Step 4: Pull env vars + install ──────────────────────
if [[ "$SETUP_VERCEL" == "y" ]]; then
  echo "Pulling env vars from Vercel to apps/web/.env.local..."
  vercel env pull apps/web/.env.local --yes
  echo "✅ .env.local generated from Vercel"
else
  cp .env.example apps/web/.env.local
  if [[ -n "$DATABASE_URL" ]]; then
    grep -v '^DATABASE_URL=' apps/web/.env.local > apps/web/.env.local.tmp
    echo "DATABASE_URL=${DATABASE_URL}" >> apps/web/.env.local.tmp
    mv apps/web/.env.local.tmp apps/web/.env.local
  fi
  echo "✅ .env.local generated"
fi

echo "Installing dependencies..."
bun install

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ ${PROJECT_NAME} is ready!"
echo "═══════════════════════════════════════════"
echo ""
echo "  bun run dev        Start dev server"
echo "  bun run build      Build for production"
echo "  bun run test       Run tests"
echo ""
[[ "$SETUP_VERCEL" == "y" ]] && echo "  Vercel:   Linked ✓"
[[ -n "$DATABASE_URL" ]] && echo "  Neon:     Connected ✓"
echo ""
echo "  Manual setup (optional):"
echo "  - Sentry: create project at sentry.io, add NEXT_PUBLIC_SENTRY_DSN to Vercel"
echo "  - PostHog: create project at posthog.com, add NEXT_PUBLIC_POSTHOG_KEY to Vercel"
echo ""
