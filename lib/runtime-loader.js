let runtimeParentURL;
let physicalPackagePrefixes = [];

export function initialize(data) {
  if (typeof data?.runtimeParentURL !== 'string') {
    throw new TypeError('The runtime loader requires runtimeParentURL.');
  }
  runtimeParentURL = data.runtimeParentURL;
  physicalPackagePrefixes = Array.isArray(data.physicalPackagePrefixes)
    ? data.physicalPackagePrefixes.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
}

export function isBareSpecifier(specifier) {
  return !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('file:')
    && !specifier.startsWith('node:')
    && !specifier.startsWith('data:');
}

export function mapPhysicalPackage(resolved, prefixes = physicalPackagePrefixes) {
  if (typeof resolved?.url !== 'string' || !resolved.url.includes('.asar/')) return resolved;
  const physical = prefixes.some((prefix) => resolved.url.includes(`/node_modules/${prefix}`));
  return physical
    ? { ...resolved, url: resolved.url.replace('.asar/', '.asar.unpacked/') }
    : resolved;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return mapPhysicalPackage(await nextResolve(specifier, context));
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !isBareSpecifier(specifier)) throw error;
    return mapPhysicalPackage(await nextResolve(specifier, {
      ...context,
      parentURL: runtimeParentURL,
    }));
  }
}
