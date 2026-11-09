import ProjectDetailClient from "./ProjectDetailClient.js";

export const metadata = { title: "Project Memory · 9Router" };

export default async function ProjectDetailPage({ params }) {
  const { id } = await params;
  return <ProjectDetailClient projectId={id} />;
}
