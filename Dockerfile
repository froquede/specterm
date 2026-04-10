FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for Tauri v2
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    wget \
    file \
    libglib2.0-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Tauri CLI
RUN cargo install tauri-cli --version "^2"

WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest
COPY . .

# Build
RUN cargo tauri build --bundles appimage 2>&1

# Output stage
FROM scratch AS output
COPY --from=builder /app/src-tauri/target/release/bundle/appimage/*.AppImage /
