import streamifier from 'streamifier';
import { getCloudinaryClient } from './cloudinaryClient.js';

const BASE_FOLDER = 'formular';

export async function uploadImageBuffer(buffer, subfolder) {
  const cloudinary = await getCloudinaryClient();
  const folder = `${BASE_FOLDER}/${subfolder}`;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}