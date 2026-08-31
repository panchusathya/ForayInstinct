import type { EveMessage } from "eve/react";
import { isVisibleJobCardToolPart } from "@/lib/goforay/job-cards";

export function userVisibleParts(
  message: EveMessage,
  deliveredAssistantMessages?: ReadonlyMap<number, readonly string[]>
) {
  if (message.role === "user") {
    return message.parts.filter(
      (part) => part.type === "text" || part.type === "file"
    );
  }

  const remainingDeliveries = new Map(
    [...(deliveredAssistantMessages ?? [])].map(([stepIndex, messages]) => [
      stepIndex,
      [...messages],
    ])
  );

  return message.parts.filter((part) => {
    if (part.type === "text" && part.stepIndex !== undefined) {
      const deliveries = remainingDeliveries.get(part.stepIndex);
      const deliveryIndex = deliveries?.indexOf(part.text) ?? -1;
      if (deliveryIndex < 0 || !deliveries) return false;
      deliveries.splice(deliveryIndex, 1);
      return true;
    }

    if (part.type === "authorization") return true;
    if (isVisibleJobCardToolPart(part)) return true;

    return (
      part.type === "dynamic-tool" &&
      part.toolMetadata?.eve?.inputRequest !== undefined
    );
  });
}
