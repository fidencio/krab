FROM rust:1.96-bookworm AS build
WORKDIR /src
COPY controller/Cargo.toml controller/Cargo.lock ./
COPY controller/src ./src
RUN cargo build --locked --release

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/krab-controller /usr/local/bin/krab-controller
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/krab-controller"]
