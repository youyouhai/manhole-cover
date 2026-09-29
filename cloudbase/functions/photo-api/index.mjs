import { createPhotoApiServer } from './app.mjs';
import { createCloudBasePhotoRepositoryFromEnv } from './cloudbase-repository.mjs';

const port = Number(process.env.PORT || 9000);
const repository = createCloudBasePhotoRepositoryFromEnv();

createPhotoApiServer({ repository }).listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'photo-api.started',
    port,
    deviceConfigurationPresent: Boolean(process.env.PHOTO_DEVICE_TOKENS_JSON),
  }));
});
