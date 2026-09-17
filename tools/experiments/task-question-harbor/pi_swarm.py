"""Harbor adapter for an explicit, credential-free Pi-Swarm snapshot."""
import os
import shlex
from pathlib import Path
from harbor.agents.installed.pi import Pi
from harbor.agents.installed.node_install import nvm_node_install_snippet

class PiSwarm(Pi):
    @staticmethod
    def name():
        return "pi-swarm"

    async def install(self, environment):
        archive = Path(os.environ["PI_SWARM_HARBOR_ARCHIVE"]).resolve(strict=True)
        await environment.upload_file(archive, "/tmp/pi-swarm.tar.gz")
        await self.exec_as_root(environment, command="rm -rf /var/lib/apt/lists/* && apt-get -o APT::Sandbox::User=root -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update && apt-get -o APT::Sandbox::User=root -o Acquire::Retries=3 install -y curl git", env={"DEBIAN_FRONTEND":"noninteractive"})
        await self.exec_as_agent(environment, command=(
            "set -euo pipefail; " + nvm_node_install_snippet() +
            " && npm install -g @earendil-works/pi-coding-agent@0.85.0"
            " && mkdir -p $HOME/pi-swarm"
            " && tar -xzf /tmp/pi-swarm.tar.gz -C $HOME/pi-swarm"
            " && cd $HOME/pi-swarm && npm ci"
            " && pi install $HOME/pi-swarm"
            " && pi --version"
        ))
        # Retain proof of package installation. Tool execution is separately smoked.
        await self.exec_as_agent(environment, command="cat $HOME/.pi/agent/settings.json > /logs/agent/pi-swarm-install.json")
