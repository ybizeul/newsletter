# Collaborative Newsletter Platform

Collaborative newsletter product monorepo:
- Frontend: Vite + React + Mantine
- Backend: Go + Chi + MongoDB
- Delivery: SMTP send with scheduling
- Runtime model: compiled web UI is embedded in the API binary and served on `/`

## Project Layout

- `apps/web`: React web app
- `apps/api`: Go API server
- `local/docker-compose.yml`: local dependencies (MongoDB)
- `infra/docker/docker-compose.yml`: Docker Compose deployment example
- `infra/k8s`: Kubernetes resource file examples

## Product Notes

### Favorite newsletter workflow

- The favorite newsletter is stored in browser local storage (`newsletter.favorite.id`).
- Only one newsletter can be favorite at a time.
- In the newsletters list, the favorite newsletter shows a yellow star next to its title.
- In the articles list, articles that belong to the favorite newsletter show a blue envelope icon next to their title.
- In article edit view, the action button toggles between:
	- `Add to <favorite newsletter>` (white star)
	- `Remove from <favorite newsletter>` (yellow star)
- If no favorite newsletter is defined, the add/remove button is hidden.

## Local Development

### Start local dependencies

```bash
cd local
docker compose up -d
```

Or with Mise:

```bash
mise run deps:up
```

### Run API + embedded UI

Build the web app into the API embedded assets, then run the API:

```bash
cd apps/web
npm install
npm run build

cd ../api
go run ./cmd/server
```

Then open:
- App: http://localhost:8080/
- API health: http://localhost:8080/health

## Deployment Example: Docker Compose

Use the deployment-oriented compose file at `infra/docker/docker-compose.yml`.

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

This starts:
- `mongodb`
- `api` (serves UI on `/` and API routes under `/api`)

Update these values before production use:
- `api.image`
- SMTP settings (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, etc.)

## Deployment Example: Kubernetes Resource Files

Example files are provided in `infra/k8s`:
- `namespace.yaml`
- `secret.example.yaml`
- `mongodb.yaml`
- `api.yaml`

### 1) Create namespace

```bash
kubectl apply -f infra/k8s/namespace.yaml
```

### 2) Create secret

Copy the example and set a real SMTP password:

```bash
cp infra/k8s/secret.example.yaml infra/k8s/secret.yaml
# edit infra/k8s/secret.yaml
kubectl apply -f infra/k8s/secret.yaml
```

### 3) Apply database and API resources

```bash
kubectl apply -f infra/k8s/mongodb.yaml
kubectl apply -f infra/k8s/api.yaml
```

### 4) Verify deployment

```bash
kubectl -n newsletter get pods,svc,ingress
```

Before using in production, update:
- API image in `infra/k8s/api.yaml`
- Ingress host in `infra/k8s/api.yaml`
- Inline env vars in `infra/k8s/api.yaml` (SMTP host/from, Mongo URI, timezone)
- SMTP credentials in Secret (`SMTP_USER`, `SMTP_PASS`)

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_PORT` | No | `8080` | HTTP listen port |
| `MONGO_URI` | No | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGO_DATABASE` | No | `newsletter` | MongoDB database name |
| `SMTP_HOST` | No | *(empty — sending disabled)* | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_FROM` | No | `no-reply@example.com` | Sender email address |
| `SMTP_USER` | No | *(empty — no auth)* | SMTP username |
| `SMTP_PASS` | No | *(empty)* | SMTP password |
| `DEFAULT_TZ` | No | `UTC` | Default timezone for scheduling |
| `OIDC_ISSUER` | No | *(empty — auth disabled)* | OIDC issuer URL (e.g. `https://auth.example.com`) |
| `OIDC_APPLICATION_ID` | No | *(empty)* | OIDC / OAuth2 client ID |
| `OIDC_SECRET` | No | *(empty)* | OIDC / OAuth2 client secret |

### OIDC Authentication

When all three `OIDC_*` variables are set, the platform enables OpenID Connect authentication:

- Users are redirected to the OIDC provider to sign in.
- The callback URL is `https://<host>/callback` (auto-derived from the request `Host` header). Register this URL with your OIDC provider.
- After login, a signed session cookie (`newsletter_session`, 24 h TTL) is set.
- The authenticated user's OIDC `sub` claim is used as `authorId` / `creatorId` on created resources.
- A user name and logout button appear in the app header.

When the `OIDC_*` variables are **not** set, the app runs without authentication (demo / single-user mode).

## Notes

- If the web UI changes, rebuild in `apps/web` so new assets are embedded.
- API expects env vars described in `apps/api/internal/config/config.go`.
