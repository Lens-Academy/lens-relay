import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { EDU_FOLDER_ID } from '../../lib/constants';
import { PromotionPage } from './PromotionPage';

export function PromotionRoute() {
  const { canPromote, folderUuid, isAllFolders } = useAuth();
  const hasFolderAccess = isAllFolders || folderUuid === EDU_FOLDER_ID;

  if (canPromote && hasFolderAccess) return <PromotionPage />;

  return (
    <main className="h-full bg-gray-50 flex items-center justify-center">
      <div className="max-w-md px-6 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Admin access required</h1>
        <p className="mt-2 text-gray-600">
          You need an admin access token to use production promotion.
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-blue-600 underline hover:text-blue-800">
          Return to editor
        </Link>
      </div>
    </main>
  );
}
