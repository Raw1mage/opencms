#!/usr/bin/env bun

interface PR {
  number: number
  headRefName: string
  headRefOid: string
  createdAt: string
  isDraft: boolean
  title: string
}

async function conflicts() {
  const out = await $`git diff --name-only --diff-filter=U`
    .nothrow()
    .then((r) => r.stdout)
    .catch(() => "")
  return out
    .split("\n")
    .map((x: string) => x.trim())
    .filter(Boolean)
}

async function cleanup() {
  await $`git rebase --abort`.nothrow()
  await $`git merge --abort`.nothrow()
  await $`git reset --hard HEAD`.nothrow()
  await $`git checkout -- .`.nothrow()
  await $`git clean -fd`.nothrow()
}

async function run(args: string[]) {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

async function fix(pr: PR, files: string[]) {
  console.log(`  Trying to auto-resolve ${files.length} conflict(s) with opencode...`)
  const prompt = [
    `Resolve the current git rebase conflicts while processing PR #${pr.number} into the beta branch.`,
    `Only touch these files: ${files.join(", ")}.`,
    "Keep the rebase in progress, do not abort the rebase, and do not create a commit.",
    "When done, leave the working tree with no unmerged files.",
  ].join("\n")

  const opencode = await run(["opencode", "run", "-m", "opencode/gpt-5.3-codex", prompt])
  if (opencode.exitCode !== 0) {
    console.log(`  opencode failed: ${opencode.stderr || opencode.stdout}`)
    return false
  }

  const left = await conflicts()
  if (left.length > 0) {
    console.log(`  Conflicts remain: ${left.join(", ")}`)
    return false
  }

  console.log("  Conflicts resolved with opencode")
  return true
}

async function main() {
  console.log("Fetching open contributor PRs...")

  const prsResult =
    await $`gh pr list --label contributor --state open --json number,headRefName,headRefOid,createdAt,isDraft,title --limit 100`.nothrow()
  if (prsResult.exitCode !== 0) {
    throw new Error(`Failed to fetch PRs: ${prsResult.stderr}`)
  }

  const allPRs: PR[] = JSON.parse(prsResult.stdout)
  const prs = allPRs.filter((pr) => !pr.isDraft).sort((a: PR, b: PR) => a.number - b.number)

  console.log(`Found ${prs.length} open non-draft contributor PRs`)

  console.log("Fetching latest dev branch...")
  const fetchDev = await $`git fetch origin dev`.nothrow()
  if (fetchDev.exitCode !== 0) {
    throw new Error(`Failed to fetch dev branch: ${fetchDev.stderr}`)
  }

  console.log("Checking out beta branch...")
  const checkoutBeta = await $`git checkout -B beta origin/dev`.nothrow()
  if (checkoutBeta.exitCode !== 0) {
    throw new Error(`Failed to checkout beta branch: ${checkoutBeta.stderr}`)
  }

  const applied: number[] = []
  const skipped: Array<{ number: number; reason: string }> = []

  for (const pr of prs) {
    console.log(`\nProcessing PR #${pr.number}: ${pr.title}`)

    // Fetch the PR
    const fetchPR = await $`git fetch origin pull/${pr.number}/head:pr-${pr.number}`.nothrow()
    if (fetchPR.exitCode !== 0) {
      console.log(`  Failed to fetch PR #${pr.number}, skipping`)
      skipped.push({ number: pr.number, reason: "Failed to fetch" })
      continue
    }

    // Try to rebase onto current beta branch
    console.log(`  Attempting to rebase PR #${pr.number}...`)
    const rebase = await $`git rebase beta pr-${pr.number}`.nothrow()
    if (rebase.exitCode !== 0) {
      const files = await conflicts()
      if (files.length > 0) {
        console.log(`  Rebase failed for PR #${pr.number} (has conflicts)`)
        if (!(await fix(pr, files))) {
          await cleanup()
          await $`git checkout beta`.nothrow()
          skipped.push({ number: pr.number, reason: "Rebase failed (conflicts)" })
          continue
        }

        let rebaseRecovered = true
        while (true) {
          await $`git add -A`.nothrow()
          const cont = await $`git rebase --continue`.nothrow()
          if (cont.exitCode === 0) break
          const remaining = await conflicts()
          if (remaining.length === 0 || !(await fix(pr, remaining))) {
            await cleanup()
            await $`git checkout beta`.nothrow()
            skipped.push({ number: pr.number, reason: "Rebase continue failed after auto-resolve" })
            rebaseRecovered = false
            break
          }
        }
        if (!rebaseRecovered) continue
      } else {
        console.log(`  Rebase failed for PR #${pr.number}`)
        await cleanup()
        await $`git checkout beta`.nothrow()
        skipped.push({ number: pr.number, reason: "Rebase failed" })
        continue
      }
    }

    // Move rebased commits to pr-${pr.number} branch and checkout back to beta
    await $`git checkout -B pr-${pr.number}`.nothrow()
    await $`git checkout beta`.nothrow()

    console.log(`  Successfully rebased PR #${pr.number}`)

    // Now squash merge the rebased PR
    const merge = await $`git merge --squash pr-${pr.number}`.nothrow()
    if (merge.exitCode !== 0) {
      console.log(`  Squash merge failed for PR #${pr.number}`)
      console.log(`  Error: ${merge.stderr}`)
      await $`git reset --hard HEAD`.nothrow()
      skipped.push({ number: pr.number, reason: `Squash merge failed: ${merge.stderr}` })
      continue
    }

    const add = await $`git add -A`.nothrow()
    if (add.exitCode !== 0) {
      console.log(`  Failed to stage changes for PR #${pr.number}`)
      await $`git reset --hard HEAD`.nothrow()
      skipped.push({ number: pr.number, reason: "Failed to stage" })
      continue
    }

    const status = await $`git status --porcelain`.nothrow()
    if (status.exitCode !== 0 || !status.stdout.trim()) {
      console.log(`  No changes to commit for PR #${pr.number}, skipping`)
      await $`git reset --hard HEAD`.nothrow()
      skipped.push({ number: pr.number, reason: "No changes to commit" })
      continue
    }

    const commitMsg = `Apply PR #${pr.number}: ${pr.title}`
    const commit = await Bun.spawn(["git", "commit", "-m", commitMsg], { stdout: "pipe", stderr: "pipe" })
    const commitExit = await commit.exited
    const commitStderr = await Bun.readableStreamToText(commit.stderr)

    if (commitExit !== 0) {
      console.log(`  Failed to commit PR #${pr.number}`)
      console.log(`  Error: ${commitStderr}`)
      await $`git reset --hard HEAD`.nothrow()
      skipped.push({ number: pr.number, reason: `Commit failed: ${commitStderr}` })
      continue
    }

    console.log(`  Successfully applied PR #${pr.number}`)
    applied.push(pr.number)
  }

  console.log("\n--- Summary ---")
  console.log(`Applied: ${applied.length} PRs`)
  applied.forEach((num) => console.log(`  - PR #${num}`))
  console.log(`Skipped: ${skipped.length} PRs`)
  skipped.forEach((x) => console.log(`  - PR #${x.number}: ${x.reason}`))

  console.log("\nForce pushing beta branch...")
  const push = await $`git push origin beta --force`.nothrow()
  if (push.exitCode !== 0) {
    throw new Error(`Failed to push beta branch: ${push.stderr}`)
  }

  console.log("Successfully synced beta branch")
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})

function $(strings: TemplateStringsArray, ...values: unknown[]) {
  const cmd = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")
  return {
    async nothrow() {
      const proc = Bun.spawn(cmd.split(" "), {
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      return { exitCode, stdout, stderr }
    },
  }
}
