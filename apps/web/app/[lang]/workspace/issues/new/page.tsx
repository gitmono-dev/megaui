import { IssueComposer } from "./issue-composer";

export default async function NewIssuePage({ searchParams }: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  return <IssueComposer listQuery={typeof q === "string" ? q : ""} />;
}
