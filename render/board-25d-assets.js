(function (root) {
  'use strict';

  const HD_ASSETS = [
    ...['blue', 'red'].flatMap(side => ['flag', 'shield', 'spear', 'archer', 'cavalry']
      .map(type => `units/${side}_${type}.png`)),
    ...['grass', 'forest_floor', 'hilltop', 'cliff_face', 'fog_cloud'].map(name => `terrain/${name}.png`),
    ...['pine_a', 'pine_b', 'pine_c', 'bush_a', 'bush_b', 'fern', 'rock_a', 'rock_b',
      'rubble', 'flowers', 'grass_tuft'].map(name => `props/${name}.png`)
  ];

  const scriptUrl = typeof document === 'undefined' ? null : document.currentScript?.src;
  const baseUrl = scriptUrl ? new URL('../assets/hd25d/', scriptUrl) : null;

  function create(onLoad) {
    const images = new Map();
    let loading;

    return {
      get: name => images.get(name) || null,
      load() {
        // 本機檔案模式直接使用程序繪圖，避免混入來源不明的畫布。
        if (typeof Image === 'undefined' || typeof document === 'undefined' ||
            document.location.protocol === 'file:') return Promise.resolve([]);
        if (!loading) {
          const base = baseUrl || new URL('assets/hd25d/', document.baseURI);
          loading = Promise.allSettled(HD_ASSETS.map(name => new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
              images.set(name, image);
              onLoad(name);
              resolve(image);
            };
            image.onerror = reject;
            image.src = new URL(name, base).href;
          })));
        }
        return loading;
      }
    };
  }

  root.TFC25DAssets = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
