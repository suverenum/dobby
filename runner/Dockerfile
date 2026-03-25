FROM ubuntu:24.04

# Prevent interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    jq \
    ssh \
    ca-certificates \
    gnupg \
    unzip \
    zip \
    build-essential \
    ripgrep \
    less \
    file \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 24 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Install Python dev tools
RUN pip3 install --no-cache-dir --break-system-packages \
    pytest \
    ruff \
    mypy \
    black

# Install OpenCode CLI
RUN npm install -g opencode-ai

# Install dolt (required by beads)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/dolthub/dolt/releases/latest/download/dolt-linux-${ARCH}.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local dolt-linux-${ARCH}/bin/dolt

# Install beads (bd) for issue tracking
RUN ARCH=$(dpkg --print-architecture) && \
    BD_VERSION=$(curl -sf https://api.github.com/repos/steveyegge/beads/releases/latest | jq -r .tag_name) && \
    curl -fsSL "https://github.com/steveyegge/beads/releases/download/${BD_VERSION}/beads_${BD_VERSION#v}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin bd && \
    chmod +x /usr/local/bin/bd

# Install beads viewer (bv) for robot triage
RUN ARCH=$(dpkg --print-architecture) && \
    BV_VERSION=$(curl -sf https://api.github.com/repos/Dicklesworthstone/beads_viewer/releases/latest | jq -r .tag_name) && \
    curl -fsSL "https://github.com/Dicklesworthstone/beads_viewer/releases/download/${BV_VERSION}/bv_${BV_VERSION#v}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin bv && \
    chmod +x /usr/local/bin/bv

# Create non-root user and workspace
RUN useradd -m -s /bin/bash dobby \
  && mkdir -p /workspace \
  && chown dobby:dobby /workspace

# Clone myhyperpowers and install skills/agents for OpenCode
RUN git clone --depth=1 https://github.com/dpolishuk/myhyperpowers.git /opt/myhyperpowers 2>&1 || \
    (echo "Clone failed, retrying..." && sleep 2 && git clone --depth=1 https://github.com/dpolishuk/myhyperpowers.git /opt/myhyperpowers)

# Install hyperpowers skills and agents to dobby's OpenCode config
RUN HP=/opt/myhyperpowers && OC=/home/dobby/.config/opencode \
  && mkdir -p "$OC/skills" "$OC/agents" "$OC/commands" "$OC/plugins" \
  && for d in "$HP"/.opencode/skills/hyperpowers-*/; do [ -d "$d" ] && cp -R "$d" "$OC/skills/"; done \
  && [ -d "$HP/.opencode/skills/beads-triage" ] && cp -R "$HP/.opencode/skills/beads-triage" "$OC/skills/" || true \
  && for f in "$HP"/.opencode/agents/*.md; do [ -f "$f" ] && cp "$f" "$OC/agents/"; done \
  && for f in "$HP"/.opencode/commands/*.md; do [ -f "$f" ] && cp "$f" "$OC/commands/"; done \
  && for f in "$HP"/.opencode/plugins/*.ts; do [ -f "$f" ] && cp "$f" "$OC/plugins/"; done || true \
  && chown -R dobby:dobby /home/dobby/.config

# Copy entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER dobby
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
