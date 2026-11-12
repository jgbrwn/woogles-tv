# syntax=docker/dockerfile:1
# Woogles-TV: single static Go binary (web UI embedded) + Macondo data files.
FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/woogles-tv .
# Download the word lists (NWL23, CSW24) and bot leave files from the Woogles repository into the image,
# so the container works offline. (Built natively for the build platform in case of cross-builds.)
RUN CGO_ENABLED=0 go build -o /tmp/fetch . && mkdir -p /out/data/rooms \
 && cp -r data/letterdistributions data/strategy /out/data/ && /tmp/fetch -data /out/data -fetch-only

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/woogles-tv /app/woogles-tv
# Game data ships in the image; only saved rooms/games (data/rooms) need a volume.
COPY --chown=nonroot:nonroot --from=build /out/data /app/data
VOLUME /app/data/rooms
EXPOSE 8420
ENTRYPOINT ["/app/woogles-tv", "-addr", ":8420", "-data", "/app/data"]
