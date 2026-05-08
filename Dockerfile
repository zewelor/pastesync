FROM --platform=$BUILDPLATFORM golang:1 AS base
ENV GOTOOLCHAIN=local

FROM base AS validate
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY main.go main_test.go ./
COPY web ./web
RUN test -z "$(gofmt -l main.go main_test.go)"
RUN go test ./...
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath ./...

FROM base AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY main.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/pastesync ./

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/pastesync /app/pastesync
EXPOSE 8080
ENTRYPOINT ["/app/pastesync"]
