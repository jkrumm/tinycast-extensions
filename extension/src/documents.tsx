import { open } from "@raycast/api";
import { documentsUrl } from "./lib/argo";

export default async function Documents() {
  await open(documentsUrl());
}
