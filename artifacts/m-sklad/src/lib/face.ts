/**
 * Face recognition in the browser (face-api, MIT). Models are served by our own server
 * from /models/face — works without internet. Loaded only by the kiosk and enrolment.
 */
type FaceApi = typeof import("@vladmandic/face-api");
let api: Promise<FaceApi> | null = null;

export function loadFaceApi(): Promise<FaceApi> {
  api ??= (async () => {
    const faceapi = await import("@vladmandic/face-api");
    const url = `${import.meta.env.BASE_URL}models/face`;
    await (faceapi.tf as unknown as { ready?: () => Promise<void> }).ready?.();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(url),
      faceapi.nets.faceLandmark68Net.loadFromUri(url),
      faceapi.nets.faceRecognitionNet.loadFromUri(url),
    ]);
    return faceapi;
  })();
  api.catch(() => { api = null; });
  return api;
}

export interface FaceShot {
  descriptor: number[]; score: number; size: number;
  /** In video pixels — used to draw the scanner overlay. */
  box: { x: number; y: number; width: number; height: number };
  points: { x: number; y: number }[];
}

/**
 * One face in the frame → its descriptor, box and 68 landmark points, and whether it is close and
 * clear enough to identify. null — no face, "many" — several faces.
 */
export async function scanFace(video: HTMLVideoElement, minSize = 0.18): Promise<{ shot: FaceShot; close: boolean } | "many" | null> {
  const faceapi = await loadFaceApi();
  if (!video.videoWidth) return null;
  const all = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptors();
  if (!all.length) return null;
  if (all.length > 1) return "many";
  const f = all[0];
  const b = f.detection.box;
  const shot: FaceShot = {
    descriptor: Array.from(f.descriptor), score: f.detection.score, size: b.width / video.videoWidth,
    box: { x: b.x, y: b.y, width: b.width, height: b.height }, points: f.landmarks.positions.map((p) => ({ x: p.x, y: p.y })),
  };
  return { shot, close: shot.size >= minSize && shot.score >= 0.7 };
}

/** Back-compat: descriptor-only detection. */
export async function detectFace(video: HTMLVideoElement, minSize = 0.18): Promise<FaceShot | "many" | null> {
  const r = await scanFace(video, minSize);
  if (r === "many" || r === null) return r;
  return r.close ? r.shot : null;
}
