import { NextResponse } from "next/server";
import { UserFacingError } from "@/lib/backend/types";
import { documentLink } from "@/lib/precon/service";
import { preconContext } from "../../../_lib";

/**
 * Opens a stored file. Authenticates, checks that this user may see the document (through the user-scoped repository and,
 * independently, the storage policy), then redirects to a signed URL that expires in 60 seconds. No storage path or credential
 * is ever returned to the browser, and nothing is cached.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, ctx] = await Promise.all([params, preconContext()]);
  try {
    const url = await documentLink(ctx, id, { download: new URL(req.url).searchParams.get("download") === "1" });
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (!(e instanceof UserFacingError)) console.error("[precon] file link", e);
    // Same answer for "does not exist" and "not yours", so ids cannot be probed.
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
