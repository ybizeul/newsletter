FROM golang:1.25-alpine AS builder
WORKDIR /app

COPY apps/api/go.mod ./go.mod
RUN go mod download

COPY apps/api ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/api ./cmd/server

FROM alpine:3.21
WORKDIR /srv
COPY --from=builder /bin/api /usr/local/bin/api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
