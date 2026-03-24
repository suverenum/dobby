FROM ubuntu:24.04

# Prevent interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    jq \
    ssh \
    ca-certificates \
    gnupg \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 24 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install Python dev tools
RUN pip3 install --no-cache-dir --break-system-packages \
    pytest \
    ruff \
    mypy \
    black

# Install Claude Code CLI and OpenAI Codex CLI
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
  && CLAUDE_REAL=$(which claude) \
  && mv "${CLAUDE_REAL}" "${CLAUDE_REAL}-real" \
  && printf '#!/usr/bin/env bash\nexec "%s-real" --bare "$@"\n' "${CLAUDE_REAL}" > "${CLAUDE_REAL}" \
  && chmod +x "${CLAUDE_REAL}"

# Install Ralphex
RUN ARCH=$(dpkg --print-architecture) && \
    RALPHEX_VERSION=$(curl -sf https://api.github.com/repos/umputun/ralphex/releases/latest | jq -r .tag_name) && \
    curl -fsSL "https://github.com/umputun/ralphex/releases/download/${RALPHEX_VERSION}/ralphex_${RALPHEX_VERSION#v}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin ralphex && \
    chmod +x /usr/local/bin/ralphex

# Create non-root user and workspace
RUN useradd -m -s /bin/bash dobby \
  && mkdir -p /workspace \
  && chown dobby:dobby /workspace

# Copy entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER dobby
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
