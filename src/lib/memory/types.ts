export interface MemoryInsight {
  title: string;
  description: string;
  people: string[];
  setting: string;
  location: string | null;
  event: string | null;
  activities: string[];
  objects: string[];
  mood: string[];
  tags: string[];
  visualQuality: number;
}

export interface MemoryRecord extends MemoryInsight {
  id: string;
  /** Relative to workspace/memories. */
  mediaFile: string;
  mime: string;
  bytes: number;
  sha256: string;
  originalName: string;
  capturedAt: string | null;
  userNote: string;
  context: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  provenance: {
    observedBy: "gemini" | "local";
    modelRoute: string;
  };
}

export interface MemoryView extends Omit<MemoryRecord, "mediaFile"> {
  imageUrl: string;
  searchText: string;
}

export interface MemorySelection {
  memories: MemoryView[];
  summary: string;
  storyAngle: string;
  route: string;
}
