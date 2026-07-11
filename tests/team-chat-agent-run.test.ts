import { describe, expect, test } from "bun:test";

import {
  buildTeamChatAgentContinuationInput,
  buildTeamChatSelectedActionRunInput,
} from "../apps/web/src/hooks/useTeamChat";
import { actionMentionMatchesForQuery } from "../apps/web/src/lib/action-mentions";

describe("desktop Team Chat agent continuation", () => {
  test("matches the hosted workspace agent in the shared desktop composer", () => {
    const action = {
      id: "project_profile:agent_oauth_verifier:read-record",
      label: "OAuth Verifier Agent · Read record",
      description: "Read the deterministic OAuth fixture record.",
      implementation: {
        type: "openpond-agent",
        agentId: "agent_oauth_verifier",
        agentName: "OAuth Verifier Agent",
        actionId: "read-record",
        profileProjectId: "project_profile",
        profileName: "default",
      },
    };

    expect(actionMentionMatchesForQuery([action], "oauth")).toEqual([
      action,
    ]);
  });

  test("submits the exact composer-selected action key", () => {
    expect(
      buildTeamChatSelectedActionRunInput({
        teamId: "team_1",
        body: "  read the deterministic record  ",
        clientRequestId: "request_selected_action",
        selectedActionKey:
          "project_profile:agent_oauth_verifier:read-record",
      }),
    ).toEqual({
      teamId: "team_1",
      body: "read the deterministic record",
      clientRequestId: "request_selected_action",
      selectedActionKey:
        "project_profile:agent_oauth_verifier:read-record",
    });
  });

  test("pins a sidebar follow-up to the open shared agent conversation", () => {
    const request = buildTeamChatAgentContinuationInput({
      teamId: "team_1",
      body: "  continue from the pinned source  ",
      clientRequestId: "request_stable_retry",
      conversation: {
        conversationId: "conversation_oauth_verifier",
        teamId: "team_1",
        title: "OAuth verifier",
        agent: {
          id: "agent_oauth_verifier",
          name: "OAuth Verifier Agent",
          slug: "openpond-profile-oauth-verifier",
        },
        run: {
          id: "run_oauth_verifier",
          status: "succeeded",
          metadata: {},
        },
        messages: [],
        pinnedRouting: {
          profileProjectId: "project_profile",
          sourceCommitSha: "source_sha",
        },
      },
    });

    expect(request).toEqual({
      teamId: "team_1",
      body: "continue from the pinned source",
      clientRequestId: "request_stable_retry",
      selectedAgentId: "agent_oauth_verifier",
      conversationId: "conversation_oauth_verifier",
    });
  });
});
