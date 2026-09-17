"""Trial-local FEX command wrapper; leaves host binfmt and task images unchanged."""
import shlex
from harbor.environments.docker.docker import DockerEnvironment

class FexDockerEnvironment(DockerEnvironment):
    async def _compose_exec(self, command, *, service, cwd, env, timeout_sec, user):
        # The outer shell only execs FEX; all actual task commands run beneath it.
        wrapped = 'exec /opt/fex/FEXInterpreter /bin/bash -c ' + shlex.quote(command)
        return await super()._compose_exec(wrapped, service=service, cwd=cwd,
            env={**(env or {}), 'FEX_ROOTFS':'/', 'PATH':'/opt/fex:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'},
            timeout_sec=timeout_sec, user=user)
