FROM --platform=$BUILDPLATFORM golang:1.26-trixie AS base
ENV GOTOOLCHAIN=local

FROM base AS deps
WORKDIR /src
COPY go.mod ./
RUN go mod download

# BuildKit cache mounts (e.g. --mount=type=cache,target=/go/pkg/mod and
# /root/.cache/go-build) are deliberately omitted: go.mod has no external
# dependencies and the COPY go.mod + go mod download layer already caches
# correctly. Revisit this decision if external dependencies are added.
FROM deps AS validate
COPY main.go main_test.go ./
COPY web ./web
RUN go test ./...
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath ./...

FROM deps AS build
ARG TARGETOS
ARG TARGETARCH
COPY main.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/pastesync ./

FROM gcr.io/distroless/static-debian13:nonroot
WORKDIR /app
COPY --from=build /out/pastesync /app/pastesync
EXPOSE 8080
ENTRYPOINT ["/app/pastesync"]
