import {
  importProjectZip,
  indexProjectFile,
  listProjectFiles,
  removeAllProjectFiles,
} from "@/lib/projectMemory/fileIntelligence.js";
import { projectErrorResponse, projectJson, requireIdentity } from "../../_response.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    return projectJson({ files: await listProjectFiles(id, identity.principalId, query) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function DELETE(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    return projectJson({ deleted: await removeAllProjectFiles(id, identity) });
  } catch (error) { return projectErrorResponse(error); }
}

export async function POST(request, { params }) {
  try {
    const identity = await requireIdentity(request);
    const { id } = await params;
    const form = await request.formData();
    const uploads = [...form.getAll("files"), ...form.getAll("file")].filter((item) => item && typeof item.arrayBuffer === "function");
    if (!uploads.length) return projectJson({ error: "At least one file is required" }, 400);
    let relativePaths = [];
    try { relativePaths = JSON.parse(String(form.get("relativePaths") || "[]")); } catch { relativePaths = []; }
    const results = [];
    for (let index = 0; index < uploads.length; index += 1) {
      const upload = uploads[index];
      const buffer = Buffer.from(await upload.arrayBuffer());
      const relativePath = relativePaths[index] || upload.name;
      if (String(upload.name).toLowerCase().endsWith(".zip") || upload.type === "application/zip") {
        results.push({ archive: upload.name, ...(await importProjectZip({ projectId: id, buffer, sourceName: upload.name }, identity)) });
      } else {
        results.push(await indexProjectFile({ projectId: id, relativePath, buffer, lastModified: upload.lastModified ? new Date(upload.lastModified).toISOString() : null }, identity));
      }
    }
    return projectJson({ results }, 201);
  } catch (error) { return projectErrorResponse(error); }
}
