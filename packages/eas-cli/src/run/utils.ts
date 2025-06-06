import { AppPlatform, BuildFragment, BuildStatus } from '../graphql/generated';

function isAab(build: BuildFragment): boolean {
  return build.artifacts?.applicationArchiveUrl?.endsWith('.aab') ?? false;
}

function didArtifactsExpire(build: BuildFragment): boolean {
  return new Date().getTime() > new Date(build.expirationDate).getTime();
}

export function isRunnableOnSimulatorOrEmulator(build: BuildFragment): boolean {
  return (
    build.status === BuildStatus.Finished &&
    !!build.artifacts?.applicationArchiveUrl &&
    ((build.platform === AppPlatform.Ios && build.isForIosSimulator) ||
      (build.platform === AppPlatform.Android && !isAab(build))) &&
    !didArtifactsExpire(build)
  );
}
