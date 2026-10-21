/** Minimal Hoja (Linear-compatible GraphQL) client for /claw. The token comes from LINEAR_TOKEN and is
 *  never placed in errors, logs or results. Project names decide the team: every Hoja project belongs to
 *  exactly one team, and the assignee must be a member of that team. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "error" }) => Promise<{ status: number; text(): Promise<string> }>;
/** Only locally authored errors may cross the tool boundary. Never echo server bodies.
 *  `ambiguous` means a write may have been applied even though no usable answer arrived (timeout, dropped connection,
 *  non-200, unreadable body). Only a GraphQL error with no data is a definitive rejection: nothing was committed. */
export class HojaRequestError extends Error {
	readonly ambiguous: boolean;
	constructor(message: string, ambiguous = false) { super(message); this.ambiguous = ambiguous; }
}
export type Resolved = {
	teamId: string; teamKey: string; projectId: string; project: string; assigneeId: string; assignee: string;
	states: Record<string, string>;
};
export type IssueRef = { id: string; identifier: string };
export type IssueView = {
	id: string; identifier: string; title: string; description: string; state: string;
	teamId: string; projectId: string; assigneeId: string; comments: string[];
};

type Member = { id: string; name: string; email?: string };
type Catalog = {
	viewer: Member;
	projects: { id: string; name: string; teams: { nodes: { id: string; key: string }[] } }[];
	teams: { id: string; key: string; states: { nodes: { id: string; name: string }[] }; members: { nodes: Member[] } }[];
};

export class HojaClient {
	private catalog?: Promise<Catalog>;
	private readonly url: string;
	private readonly token: string;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;
	constructor(options: { url?: string; token?: string; fetch?: FetchLike; timeoutMs?: number } = {}) {
		this.url = options.url ?? process.env.LINEAR_API_URL ?? "https://hoja.clover4.app/graphql";
		this.token = options.token ?? process.env.LINEAR_TOKEN ?? "";
		this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
		this.timeoutMs = options.timeoutMs ?? 15_000;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Invalid Hoja timeout");
	}

	async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		if (!this.token) throw new HojaRequestError("LINEAR_TOKEN is not set; Hoja is unavailable");
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new HojaRequestError("Hoja request timed out; outcome unknown for writes. Read state before retrying.", true));
				controller.abort();
			}, this.timeoutMs);
		});
		try {
			return await Promise.race([deadline, (async () => {
				const res = await this.fetchImpl(this.url, {
					method: "POST",
					signal: controller.signal,
					redirect: "error",
					headers: { Authorization: this.token, "Content-Type": "application/json" },
					body: JSON.stringify({ query, variables }),
				});
				if (res.status !== 200) throw new HojaRequestError(`Hoja HTTP ${Number(res.status)}`, true);
				const body = await res.text();
				const parsed = JSON.parse(body);
				if (parsed.errors?.length && !parsed.data) throw new HojaRequestError("Hoja GraphQL request failed; no result accepted.");
				if (parsed.errors?.length) throw new HojaRequestError("Hoja GraphQL returned errors with data; outcome unknown.", true);
				if (!parsed.data || typeof parsed.data !== "object") throw new HojaRequestError("Hoja returned no valid data.", true);
				return parsed.data as T;
			})()]);
		} catch (error) {
			if (error instanceof HojaRequestError) throw error;
			throw new HojaRequestError("Hoja request failed; check connectivity and configuration. No server details exposed.", true);
		} finally {
			clearTimeout(timer);
		}
	}

	private load(): Promise<Catalog> {
		this.catalog ??= this.gql<any>(`{ viewer { id name email }
			projects(first: 200) { nodes { id name teams { nodes { id key } } } }
			teams { nodes { id key states { nodes { id name } } members { nodes { id name email } } } } }`)
			.then((d) => ({ viewer: d.viewer, projects: d.projects.nodes, teams: d.teams.nodes }))
			.catch((e) => { this.catalog = undefined; throw e; });
		return this.catalog;
	}

	/** project: exact name, case-insensitive. assignee: undefined or "me" = the token's user; else exact email or name substring. */
	async resolve(project: string, assignee?: string): Promise<Resolved> {
		const c = await this.load();
		const p = c.projects.find((x) => x.name.toLowerCase() === project.trim().toLowerCase());
		if (!p) throw new Error(`Hoja project "${project}" not found. Projects: ${c.projects.map((x) => x.name).join(", ")}`);
		if (p.teams.nodes.length !== 1) throw new Error(`Hoja project "${p.name}" belongs to ${p.teams.nodes.length} teams; expected exactly 1`);
		const team = c.teams.find((t) => t.id === p.teams.nodes[0].id);
		if (!team) throw new Error(`team of project "${p.name}" is not visible to this token`);
		const members = team.members.nodes;
		let who: Member | undefined;
		const want = (assignee ?? "me").trim().toLowerCase();
		if (want === "me") who = members.find((m) => m.id === c.viewer.id);
		else {
			const byEmail = members.filter((m) => m.email?.toLowerCase() === want);
			const byName = members.filter((m) => m.name.toLowerCase().includes(want));
			const exact = members.filter((m) => m.name.toLowerCase() === want);
			const hits = byEmail.length ? byEmail : exact.length ? exact : byName;
			if (hits.length > 1) throw new Error(`assignee "${assignee}" is ambiguous in ${team.key}: ${hits.map((m) => m.name).join(", ")}`);
			who = hits[0];
		}
		if (!who) throw new Error(`assignee "${assignee ?? "me"}" is not a member of team ${team.key}. Members: ${members.map((m) => m.name).join(", ")}`);
		return {
			teamId: team.id, teamKey: team.key, projectId: p.id, project: p.name, assigneeId: who.id, assignee: who.name,
			states: Object.fromEntries(team.states.nodes.map((s) => [s.name.toLowerCase(), s.id])),
		};
	}

	private stateId(r: Resolved, name: string): string {
		const id = r.states[name.toLowerCase()];
		if (!id) throw new Error(`team ${r.teamKey} has no state "${name}"`);
		return id;
	}

	async createIssue(r: Resolved, title: string, description: string, state = "In Progress"): Promise<IssueRef> {
		const d = await this.gql<any>(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`, {
			input: { title: title.slice(0, 250), description, teamId: r.teamId, projectId: r.projectId, assigneeId: r.assigneeId, stateId: this.stateId(r, state) },
		});
		if (!d.issueCreate?.success || !d.issueCreate.issue) throw new Error("Hoja issueCreate did not succeed");
		return d.issueCreate.issue;
	}

	/** Read-back used after every write; the caller compares the fields it cares about. */
	async readIssue(issueId: string): Promise<IssueView> {
		const d = await this.gql<any>(`query($id: String!) { issue(id: $id) { id identifier title description state { name } team { id } project { id } assignee { id }
			comments(first: 100) { nodes { body } } } }`, { id: issueId });
		const i = d.issue;
		if (!i) throw new Error(`Hoja issue ${issueId} not found on read-back`);
		return {
			id: i.id, identifier: i.identifier, title: i.title ?? "", description: i.description ?? "", state: i.state?.name ?? "",
			teamId: i.team?.id ?? "", projectId: i.project?.id ?? "", assigneeId: i.assignee?.id ?? "",
			comments: (i.comments?.nodes ?? []).map((c: { body: string }) => c.body),
		};
	}

	/** Reconciliation after a crash: an issue already created for this run carries its marker in the description.
	 *  Uses the server-side description filter, so the lookup is exact and not limited to a page of recent issues. */
	async findIssueByMarker(marker: string): Promise<IssueRef | undefined> {
		const d = await this.gql<any>(`{ issues(first: 50, filter: { description: { contains: ${JSON.stringify(marker)} } }) { nodes { id identifier description } } }`);
		const hit = (d.issues?.nodes ?? []).find((n: { description?: string }) => n.description?.includes(marker));
		return hit ? { id: hit.id, identifier: hit.identifier } : undefined;
	}

	async comment(issueId: string, body: string): Promise<void> {
		const d = await this.gql<any>(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body: body.slice(0, 20_000) } });
		if (!d.commentCreate?.success) throw new Error("Hoja commentCreate did not succeed");
	}

	async setState(r: Pick<Resolved, "states" | "teamKey">, issueId: string, state: string): Promise<void> {
		const d = await this.gql<any>(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
			id: issueId, input: { stateId: this.stateId(r as Resolved, state) },
		});
		if (!d.issueUpdate?.success) throw new Error("Hoja issueUpdate did not succeed");
	}
}
