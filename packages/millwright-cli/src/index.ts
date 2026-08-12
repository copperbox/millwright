export {
  DEPLOYMENT_ENV_VAR,
  Deployment,
  DeploymentManifest,
  DiscoverOptions,
  DiscoveryError,
  SsmClientLike,
  discoverDeployment,
} from './discovery';
export { InitOptions, InitResult, init } from './init';
export { buildProgram, main } from './cli';
export { VERSION } from './version';
