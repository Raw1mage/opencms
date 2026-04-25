import { useDialog } from "@opencode-ai/ui/context/dialog";
import { Dialog } from "@opencode-ai/ui/dialog";
import { Button } from "@opencode-ai/ui/button";
import { FileIcon } from "@opencode-ai/ui/file-icon";
import { TextField } from "@opencode-ai/ui/text-field";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { useGlobalSDK } from "@/context/global-sdk";
import { useGlobalSync } from "@/context/global-sync";
import { useLanguage } from "@/context/language";

interface DialogSelectDirectoryProps {
	title?: string;
	multiple?: boolean;
	onSelect: (result: string | string[] | null) => void;
}

function normalizePath(input: string) {
	const v = input.replaceAll("\\", "/");
	if (v.startsWith("//") && !v.startsWith("///"))
		return "//" + v.slice(2).replace(/\/+/g, "/");
	return v.replace(/\/+/g, "/");
}

function trimTrailing(input: string) {
	const v = normalizePath(input);
	if (v === "/") return v;
	return v.replace(/\/+$/, "") || "/";
}

function joinPath(base: string, rel: string) {
	const b = trimTrailing(base);
	const r = trimTrailing(rel).replace(/^\/+/, "");
	if (!r) return b;
	if (b === "/") return `/${r}`;
	return `${b}/${r}`;
}

function parentOf(input: string) {
	const v = trimTrailing(input);
	if (v === "/") return "/";
	const i = v.lastIndexOf("/");
	if (i <= 0) return "/";
	return v.slice(0, i);
}

function toAbsolutePath(raw: string, current: string, home: string) {
	const value = trimTrailing(raw.trim());
	if (!value) return current;
	if (value === "~") return home || current;
	if (value.startsWith("~/")) return joinPath(home || current, value.slice(2));
	if (value.startsWith("/")) return value;
	return joinPath(current, value);
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
	const dialog = useDialog();
	const sdk = useGlobalSDK();
	const sync = useGlobalSync();
	const language = useLanguage();

	const home = createMemo(() => trimTrailing(sync.data.path.home || "/"));
	const startDirectory = createMemo(() => home());

	const [currentDir, setCurrentDir] = createSignal(startDirectory());
	const [pathInput, setPathInput] = createSignal(startDirectory());
	const [errorText, setErrorText] = createSignal("");
	const [navigating, setNavigating] = createSignal(false);

	const recent = createMemo(() => {
		return sync.data.project
			.slice()
			.sort(
				(a, b) =>
					(b.time.updated ?? b.time.created) -
					(a.time.updated ?? a.time.created),
			)
			.slice(0, 5);
	});

	const displayProjectPath = (worktree: string) => {
		const h = home();
		if (!h) return worktree;
		if (worktree === h) return "~";
		if (worktree.startsWith(h + "/")) return `~${worktree.slice(h.length)}`;
		return worktree;
	};

	const listDirectory = async (absoluteDirectory: string) => {
		const target = trimTrailing(absoluteDirectory);
		return sdk.client.file
			.list({
				path: target,
			})
			.then((x) => x.data ?? []);
	};

	const [rows] = createResource(currentDir, async (directory) => {
		return listDirectory(directory).then((nodes) =>
			nodes
				.filter((n) => n.type === "directory")
				.map((n) => ({ name: n.name, absolute: trimTrailing(n.absolute) }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		);
	});

	const upDirectory = createMemo(() => parentOf(currentDir()));

	const navigateTo = async (targetRaw: string) => {
		setNavigating(true);
		const target = toAbsolutePath(targetRaw, currentDir(), home());
		setErrorText("");
		const ok = await listDirectory(target)
			.then(() => true)
			.catch(() => false);
		if (!ok) {
			setErrorText(language.t("dialog.directory.empty"));
			setNavigating(false);
			return;
		}
		setCurrentDir(trimTrailing(target));
		setPathInput(trimTrailing(target));
		setNavigating(false);
	};

	const resolveTarget = () => toAbsolutePath(pathInput(), currentDir(), home());

	const browseFromInput = async () => {
		await navigateTo(pathInput());
	};

	const confirmTarget = async () => {
		const target = resolveTarget();
		setErrorText("");
		const ok = await listDirectory(target)
			.then(() => true)
			.catch(() => false);
		if (!ok) {
			setErrorText(language.t("dialog.directory.empty"));
			return;
		}

		if (props.multiple) props.onSelect([target]);
		else props.onSelect(target);
		dialog.close();
	};

	const selectProject = (worktree: string) => {
		const target = trimTrailing(worktree);
		if (props.multiple) props.onSelect([target]);
		else props.onSelect(target);
		dialog.close();
	};

	return (
		<Dialog
			title={props.title ?? language.t("command.project.open")}
			class="w-[860px] max-w-[92vw] flex flex-col h-[85vh] max-h-[800px]"
		>
			<div class="flex flex-col gap-3 flex-1 overflow-hidden p-4">
				<div class="w-full shrink-0">
					<TextField
						value={pathInput()}
						onInput={(e) => setPathInput(e.currentTarget.value)}
						onKeyDown={(e: KeyboardEvent) => {
							if (e.key !== "Enter") return;
							e.preventDefault();
							void browseFromInput();
						}}
						class="w-full"
						placeholder={language.t("dialog.directory.search.placeholder") || "Enter or paste path..."}
					/>
				</div>

				<div class="flex-1 overflow-hidden flex flex-col min-h-0 border border-border-base rounded-md">
					<Show
						when={!rows.loading && !navigating()}
						fallback={
							<div class="p-4 text-13-regular text-text-weak text-center">
								{language.t("common.loading")}
							</div>
						}
					>
						<div class="flex-1 overflow-auto p-1">
							<div class="flex flex-col gap-1">
								<button
									type="button"
									class="w-full text-left rounded-md px-2 py-1.5 hover:bg-surface-raised-hover flex items-center gap-2 focus:ring-1 focus:ring-border-strong outline-none"
									onMouseDown={(e) => {
										e.preventDefault();
										void navigateTo(upDirectory());
									}}
								>
									<FileIcon
										node={{ path: upDirectory(), type: "directory" }}
										class="size-4 shrink-0"
									/>
									<span>..</span>
								</button>
								<For each={rows() ?? []}>
									{(row) => (
										<button
											type="button"
											class="w-full text-left rounded-md px-2 py-1.5 hover:bg-surface-raised-hover flex items-center gap-2 focus:ring-1 focus:ring-border-strong outline-none"
											onMouseDown={(e) => {
												e.preventDefault();
												void navigateTo(row.absolute);
											}}
											title={row.absolute}
										>
											<FileIcon
												node={{ path: row.absolute, type: "directory" }}
												class="size-4 shrink-0"
											/>
											<span class="truncate">{row.name}</span>
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>
				</div>

				<Show when={errorText()}>
					{(msg) => (
						<div class="text-12-regular text-icon-danger-base shrink-0">{msg()}</div>
					)}
				</Show>

				<Show when={recent().length > 0}>
					<div class="flex items-center gap-2 shrink-0 bg-surface-base p-2 rounded border border-border-base">
						<span class="text-12-regular text-text-weak shrink-0">Recent</span>
						<div class="flex flex-wrap gap-1 items-center">
							<For each={recent()}>
								{(project) => (
									<button
										type="button"
										class="px-2 py-1 rounded bg-surface-raised-base hover:bg-surface-raised-hover text-12-regular flex items-center gap-1 transition-colors"
										onClick={() => selectProject(project.worktree)}
										title={project.worktree}
									>
										<FileIcon
											node={{ path: project.worktree, type: "directory" }}
											class="size-3.5 shrink-0"
										/>
										<span class="truncate max-w-[200px]">
											{project.name ?? displayProjectPath(project.worktree)}
										</span>
									</button>
								)}
							</For>
						</div>
					</div>
				</Show>

				<div class="flex items-center justify-between gap-2 shrink-0 pt-2 border-t border-border-base mt-1">
					<div class="text-12-regular text-text-weak truncate flex-1">
						Press enter in path field to navigate
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<Button type="button" variant="ghost" onClick={() => dialog.close()}>
							Cancel
						</Button>
						<Button type="button" variant="primary" onClick={() => void confirmTarget()}>
							{language.t("command.project.open")}
						</Button>
					</div>
				</div>
			</div>
		</Dialog>
	);
}
