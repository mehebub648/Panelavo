import { GET as protectedResourceMetadata } from "../route";

export const runtime = "nodejs";

export function GET(request: Request) {
  return protectedResourceMetadata(request);
}
