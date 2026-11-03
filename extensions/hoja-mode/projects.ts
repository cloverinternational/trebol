/** Project filing is a user decision, not a repository-name guess. */
import { HojaRequestError } from "../../.pi/lib/claw/hoja.ts";

export type ProjectCatalog = {
	projects: { nodes: { id: string; name: string; description?: string; teams: { nodes: { id: string; key: string }[] } }[] };
	teams: { nodes: { id: string; key: string; name: string }[] };
};
export const PROJECT_CATALOG = `{ projects(first: 201) { nodes { id name description teams { nodes { id key } } } } teams { nodes { id key name } } }`;
export type ProjectClient = { gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> };

export function projectTool(client: ProjectClient, state: {
	enabled(): boolean;
	current(): string | undefined;
	select(name: string): unknown | Promise<unknown>;
	/** Repository-wide persistence. Only called after explicit host confirmation; the result must say whether it wrote. */
	persist?(name: string): unknown | Promise<unknown>;
	/** Journal attempts before dispatch, including uncertain outcomes. */
	attempt(name: string, teamId: string): void;
	pending(name: string, teamId: string): boolean;
	epoch(): number;
}) {
	return {
		name: "hoja_project", label: "Hoja filing project",
		description: "Discover Hoja projects and teams, including empty projects and their descriptions (action=list). action=select remembers an existing exact project for this chat and retries tasks that were queued as unfiled; pass remember:true only when the user explicitly agrees to persist it for the whole repository (host confirmation required). action=create creates a project in the exact team key after host confirmation. Resolve ownership from evidence (project descriptions, this repository) and ask the user only when genuinely ambiguous or a new project is needed; never pick by order or name similarity.",
		parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
			action: { type: "string", enum: ["list", "select", "create"] },
			name: { type: "string", description: "Exact project name." },
			team: { type: "string", description: "Exact team key for creation or disambiguation." },
			remember: { type: "boolean", description: "Persist this project for the whole repository. Requires the user's explicit agreement and a host confirmation; without it the choice applies to this chat only." },
		} },
		async execute(_id: string, params: { action: string; name?: string; team?: string; remember?: boolean }, _signal?: AbortSignal, _update?: unknown, ctx?: any) {
			const result = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {}, ...(isError ? { isError: true } : {}) });
			const epoch = state.epoch();
			const active = () => state.enabled() && state.epoch() === epoch;
			try {
				const catalog = await client.gql<ProjectCatalog>(PROJECT_CATALOG);
				if (params.action === "list") return result({ ...catalog, selectedProject: state.current(), truncated: catalog.projects.nodes.length > 200 });
				if (!active()) return result({ error: "Hoja mode is off or the session changed; no filing change made." }, true);
				const name = params.name?.trim();
				if (!name || name.length > 250) return result({ error: "Supply a project name of 1–250 characters." }, true);
				const team = params.team ? catalog.teams.nodes.find(t => t.key.toLowerCase() === params.team!.trim().toLowerCase()) : undefined;
				if (params.team && !team) return result({ error: "Team not found; use a key from action=list." }, true);
				const hits = catalog.projects.nodes.filter(p => p.name.toLowerCase() === name.toLowerCase() && (!team || p.teams.nodes.some(t => t.id === team.id)));
				if (hits.length > 1) return result({ error: "Ambiguous project name; specify its team." }, true);
				let project = hits[0];
				if (!project && params.action === "select") return result({ error: "Project not found. Ask the user where to file this work and offer action=create." }, true);
				if (!project) {
					if (params.action !== "create" || !team) return result({ error: "Creation requires action=create and an exact team key." }, true);
					if (catalog.projects.nodes.length > 200) return result({ error: "Catalog is incomplete; cannot safely rule out an existing project." }, true);
					if (state.pending(name, team.id)) return result({ error: "Earlier project creation is unconfirmed. Do not repeat it; inspect Hoja or select the committed project." }, true);
					if (!ctx?.hasUI || !ctx.ui?.confirm) return result({ error: "Interactive confirmation is required to create a project. Ask the user where to file the work; no project created." }, true);
					if (!await ctx.ui.confirm("Create Hoja project?", `Create “${name}” in team ${team.key} and file this chat's work there?`)) return result({ error: "Project creation declined; ask where to file the work." }, true);
					if (!active()) return result({ error: "Session changed; no project created." }, true);
					state.attempt(name, team.id);
					const created = await client.gql<any>(`mutation($input: ProjectCreateInput!) { projectCreate(input:$input) { success project { id } } }`, { input: { name, teamIds: [team.id] } });
					if (!created.projectCreate?.success || !created.projectCreate.project?.id) throw new HojaRequestError("Project creation unconfirmed; inspect Hoja before retrying.", true);
					const readback = await client.gql<ProjectCatalog>(PROJECT_CATALOG);
					project = readback.projects.nodes.find(p => p.id === created.projectCreate.project.id && p.name === name && p.teams.nodes.some(t => t.id === team.id))!;
					if (!project) throw new HojaRequestError("Project read-back did not confirm name and team; inspect Hoja before retrying.", true);
				}
				if (!active()) return result({ error: "Session changed; inspect Hoja for any project already created." }, true);
				// An ordinary select is session-local: a model call must not rewrite a repository-wide file. Even when
				// persistence is requested, the session selection still applies and the result reports exactly what wrote.
				let remembered = false;
				let persistenceNote: string | undefined;
				if (params.remember === true) {
					if (!ctx?.hasUI || !ctx.ui?.confirm)
						persistenceNote = "Session selection applied. Remembering it for this repository needs interactive confirmation; nothing was written.";
					else if (!await ctx.ui.confirm("Remember Hoja project?", `File this repository's future work in “${project.name}”?`))
						persistenceNote = "Session selection applied; repository persistence declined.";
					else if (!active()) return result({ error: "Session changed; no repository mapping written." }, true);
					else {
						const persisted = await state.persist?.(project.name);
						remembered = persisted === true || (!!persisted && typeof persisted === "object" && (persisted as { ok?: boolean }).ok === true);
						if (!remembered) {
							const reason = persisted && typeof persisted === "object" && (persisted as { reason?: string }).reason ? ` (${(persisted as { reason?: string }).reason})` : "";
							persistenceNote = `Session selection applied; the repository mapping was not written${reason}.`;
						}
					}
				}
				const recovered = await state.select(project.name);
				return result({
					project: project.name, id: project.id, teams: project.teams.nodes, selected: true, remembered,
					...(persistenceNote ? { note: persistenceNote } : {}),
					...(recovered ? { recovered } : {}),
					next: "Tasks that were queued as unfiled are retried automatically; a plain TaskManage update also retries them.",
				});
			} catch (error) {
				return result({ error: error instanceof HojaRequestError ? error.message : "Hoja project operation failed. Inspect the catalog before retrying; no raw server errors exposed." }, true);
			}
		},
	};
}
