import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewPass } from "./review.js";
import { TestProvider } from "../../testing/test-provider.js";
import { DEFAULT_WORKFLOW } from "../../workflow/index.js";
import { CiState, PrState } from "../../providers/provider.js";

describe("reviewPass CI gating", () => {
  it("keeps issue in To Review while CI is pending", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 10,
      title: "CI pending",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(10, {
      state: PrState.APPROVED,
      url: "https://example/pr/10",
    });
    provider.prCiStatuses.set(10, {
      state: CiState.PENDING,
      failedChecks: [],
      pendingChecks: ["build"],
    });

    const transitions = await reviewPass({
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow: { ...DEFAULT_WORKFLOW, ciGating: true },
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })) as any,
    });

    const issue = await provider.getIssue(10);
    assert.strictEqual(transitions, 0);
    assert.ok(issue.labels.includes("To Review"));
  });

  it("routes to To Improve when CI fails", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 11,
      title: "CI fail",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(11, {
      state: PrState.APPROVED,
      url: "https://example/pr/11",
    });
    provider.prCiStatuses.set(11, {
      state: CiState.FAIL,
      failedChecks: ["test"],
      pendingChecks: [],
    });

    const transitions = await reviewPass({
      workspaceDir: "/tmp",
      projectName: "devclaw",
      workflow: { ...DEFAULT_WORKFLOW, ciGating: true },
      provider,
      repoPath: "/tmp/repo",
      runCommand: (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      })) as any,
    });

    const issue = await provider.getIssue(11);
    assert.strictEqual(transitions, 1);
    assert.ok(
      issue.labels.includes("To Improve"),
      `labels=${issue.labels.join(",")}`,
    );
  });

  it("trips CI no-checks circuit breaker and moves issue to Refining", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 12,
      title: "No checks loop",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(12, {
      state: PrState.APPROVED,
      url: "https://example/pr/12",
    });
    provider.prCiStatuses.set(12, {
      state: CiState.UNKNOWN,
      failedChecks: [],
      pendingChecks: [],
      summary: "No CI checks reported for PR",
    });

    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "devclaw-ci-breaker-"),
    );
    const workflow = {
      ...DEFAULT_WORKFLOW,
      ciGating: true,
      ciNoChecksCircuitBreaker: { attempts: 2 },
    };

    const run = async () =>
      reviewPass({
        workspaceDir,
        projectName: "devclaw",
        workflow,
        provider,
        repoPath: "/tmp/repo",
        runCommand: (async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
      });

    await run();
    let issue = await provider.getIssue(12);
    assert.ok(
      issue.labels.includes("To Improve"),
      `first loop labels=${issue.labels.join(",")}`,
    );

    await provider.transitionLabel(12, "To Improve", "To Review");
    await run();
    issue = await provider.getIssue(12);
    assert.ok(
      issue.labels.includes("Refining"),
      `second loop labels=${issue.labels.join(",")}`,
    );

    const comments = await provider.listComments(12);
    assert.strictEqual(
      comments.filter((c) => c.body.includes("devclaw:ci-no-checks-breaker"))
        .length,
      1,
      "should post breaker explanation exactly once",
    );
  });

  it("dedupes under-threshold no-checks comments", async () => {
    const provider = new TestProvider();
    provider.seedIssue({
      iid: 13,
      title: "No checks dedupe",
      labels: ["To Review", "review:human"],
    });
    provider.setPrStatus(13, {
      state: PrState.APPROVED,
      url: "https://example/pr/13",
    });
    provider.prCiStatuses.set(13, {
      state: CiState.UNKNOWN,
      failedChecks: [],
      pendingChecks: [],
      summary: "No CI checks reported for PR",
    });

    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "devclaw-ci-dedupe-"),
    );
    const workflow = {
      ...DEFAULT_WORKFLOW,
      ciGating: true,
      ciNoChecksCircuitBreaker: { attempts: 5 },
    };

    const run = async () =>
      reviewPass({
        workspaceDir,
        projectName: "devclaw",
        workflow,
        provider,
        repoPath: "/tmp/repo",
        runCommand: (async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        })) as any,
      });

    await run();
    await provider.transitionLabel(13, "To Improve", "To Review");
    await run();

    const comments = await provider.listComments(13);
    assert.strictEqual(
      comments.filter((c) =>
        c.body.includes("devclaw:ci-no-checks-under-threshold"),
      ).length,
      1,
    );
  });
});
