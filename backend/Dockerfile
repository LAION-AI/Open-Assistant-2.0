# Open Assistant 2.0 — backend (Go proxy + interaction logger).
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Pure-Go SQLite (modernc) → static binary, no CGO.
RUN CGO_ENABLED=0 go build -trimpath -o /oa-backend .

FROM alpine:3.20
# CA certs for outbound HTTPS to upstream model endpoints.
RUN apk add --no-cache ca-certificates
WORKDIR /data
COPY --from=build /oa-backend /usr/local/bin/oa-backend
ENV PORT=8080
ENV DB_PATH=/data/logs.db
EXPOSE 8080
CMD ["oa-backend"]
