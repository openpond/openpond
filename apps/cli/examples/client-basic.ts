import { createClient } from "openpond";

const client = createClient({ apiKey: process.env.OPENPOND_API_KEY! });

async function main() {
  const { tools } = await client.tool.list("handle/repo");
  console.log("tools:", tools.map((tool) => tool.name));

  const result = await client.tool.run("handle/repo", "myTool", {
    body: { foo: "bar" },
  });
  console.log("tool result:", result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
