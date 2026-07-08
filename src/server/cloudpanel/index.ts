import type { CloudPanelClient } from "@/types/cloudpanel";
import { LiveCloudPanelClient } from "./live-client";
import { MockCloudPanelClient } from "./mock-client";

let client: CloudPanelClient | undefined;

export function getCloudPanelClient() {
  return (client ??=
    process.env.CLOUDPANEL_MODE === "live"
      ? new LiveCloudPanelClient()
      : new MockCloudPanelClient());
}

export function setCloudPanelClientForTests(value?: CloudPanelClient) {
  client = value;
}
