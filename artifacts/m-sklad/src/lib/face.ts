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

export interface FaceShot { descriptor: number[]; score: number; size: number }

/**
 * One face in the frame → its descriptor. Returns null when there is no face, several faces,
 * or the face is too small / unsure (the person is far from the tablet).
 */
export async function detectFace(video: HTMLVideoElement, minSize = 0.18): Promise<FaceShot | "many" | null> {
  const faceapi = await loadFaceApi();
  if (!video.videoWidth) return null;
  const all = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptors();
  if (!all.length) return null;
  if (all.length > 1) return "many";
  const f = all[0];
  const size = f.detection.box.width / video.videoWidth;
  if (size < minSize || f.detection.score < 0.7) return null;
  return { descriptor: Array.from(f.descriptor), score: f.detection.score, size };
}
