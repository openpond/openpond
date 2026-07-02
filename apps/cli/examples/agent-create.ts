import { createClient, formatStreamItem } from "openpond";

const client = createClient({ apiKey: process.env.OPENPOND_API_KEY! });

async function main() {
  const result = await client.apps.agentCreate(
    { prompt: "Build a daily digest agent" },
    {
      onItems: (items) => {
        for (const item of items) {
          const line = formatStreamItem(item);
          if (line) {
            console.log(line);
          }
        }
      },
      onAppId: (appId) => {
        console.log("app_id:", appId);
      },
      onDeploymentId: (deploymentId) => {
        console.log("deployment_id:", deploymentId);
      },
    }
  );

  console.log("conversation_id:", result.conversationId ?? "none");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
