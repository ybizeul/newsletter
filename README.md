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
- `infra/docker-compose.deploy.yml`: full Docker Compose deployment example
- `infra/k8s`: Kubernetes resource file examples

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

Use the deployment-oriented compose file at `infra/docker-compose.deploy.yml`.

```bash
docker compose -f infra/docker-compose.deploy.yml up -d
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

## Notes

- If the web UI changes, rebuild in `apps/web` so new assets are embedded.
- API expects env vars described in `apps/api/internal/config/config.go`.
