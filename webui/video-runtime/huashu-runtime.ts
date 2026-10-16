import { installBrush } from "./huashu/lib/brush";
import { installCamera } from "./huashu/lib/camera";
import { installChart } from "./huashu/lib/chart";
import { installCollage } from "./huashu/lib/collage";
import { installDiagram } from "./huashu/lib/diagram";
import { installKit } from "./huashu/lib/kit";
import { installMedia } from "./huashu/lib/media";
import { installMotion } from "./huashu/lib/motion";
import { installPaint } from "./huashu/lib/paint";
import { installPalettes } from "./huashu/lib/palettes";
import { installPost } from "./huashu/lib/post";
import { installRender } from "./huashu/lib/render";
import { installRig } from "./huashu/lib/rig";
import { installToon } from "./huashu/lib/toon";
import { installTypo } from "./huashu/lib/typo";
import { installUi } from "./huashu/lib/ui";
import { installUtil } from "./huashu/lib/util";

export type MotionLibrary = Record<string, any>;

export interface MotionVoiceEnvelope {
  fps: number;
  a: readonly number[];
}

export interface MotionToolkitOptions {
  images?: Readonly<Record<string, CanvasImageSource>>;
  voiceEnvelope?: MotionVoiceEnvelope;
}

export interface MotionToolkit {
  readonly U: MotionLibrary;
  readonly PAINT: MotionLibrary;
  readonly BRUSH: MotionLibrary;
  readonly RENDER: MotionLibrary;
  readonly POST: MotionLibrary;
  readonly PAL: MotionLibrary;
  readonly KIT: MotionLibrary;
  readonly MO: MotionLibrary;
  readonly CAM: MotionLibrary;
  readonly DG: MotionLibrary;
  readonly TY: MotionLibrary;
  readonly CH: MotionLibrary;
  readonly UI: MotionLibrary;
  readonly CL: MotionLibrary;
  readonly MD: MotionLibrary;
  readonly TOON: MotionLibrary;
  readonly RIG: MotionLibrary;
  readonly images: Readonly<Record<string, CanvasImageSource>>;
  readonly IMG: Readonly<Record<string, CanvasImageSource>>;
}

export function createMotionToolkit(
  width: number,
  height: number,
  options: MotionToolkitOptions = {},
): MotionToolkit {
  const images = Object.freeze({ ...(options.images ?? {}) });
  const scope: Record<string, any> = { IMG: images };

  if (options.voiceEnvelope) {
    const { fps, a } = options.voiceEnvelope;
    if (!Number.isFinite(fps) || fps <= 0 || !a.every((value) => Number.isFinite(value))) {
      throw new TypeError("Invalid motion voice envelope");
    }
    scope.VO_ENV = { fps, a: Array.from(a) };
  }

  installUtil(scope);
  scope.U.setStage(width, height);
  installPaint(scope);
  installPalettes(scope);
  installRig(scope);
  installKit(scope);
  installMotion(scope);
  installDiagram(scope);
  installUi(scope);
  installCollage(scope);
  installTypo(scope);
  installChart(scope);
  installMedia(scope);
  installCamera(scope);
  installToon(scope);
  installBrush(scope);
  installRender(scope);
  installPost(scope);

  return {
    U: scope.U,
    PAINT: scope.PAINT,
    BRUSH: scope.PAINT,
    RENDER: scope.PAINT,
    POST: scope.PAINT,
    PAL: scope.PAL,
    KIT: scope.KIT,
    MO: scope.MO,
    CAM: scope.CAM,
    DG: scope.DG,
    TY: scope.TY,
    CH: scope.CH,
    UI: scope.UI,
    CL: scope.CL,
    MD: scope.MD,
    TOON: scope.TOON,
    RIG: scope.RIG,
    images,
    IMG: images,
  };
}
