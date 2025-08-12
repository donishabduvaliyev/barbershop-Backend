import mongoose from 'mongoose';
const { Schema, model } = mongoose;

// A nested schema for the multilingual titles
const LocalizedStringSchema = new Schema({
    en: { type: String, required: true },
    uz: { type: String, required: true },
    ru: { type: String, required: true },
}, { _id: false }); // _id: false prevents Mongoose from creating an id for this sub-document

// The main schema for your category data
const CategorySchema = new Schema({
    // You can use your custom ID for lookups, but MongoDB's default _id is usually preferred
    id: {
        type: String,
        required: true,
        unique: true,
    },
    title: {
        type: LocalizedStringSchema,
        required: true,
    },
    route: {
        type: String,
        required: true,
    },
    icon: {
        type: String,
        required: true,
    },
    // The 'key' field is omitted as it's empty and likely not needed in the database
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
    versionKey: false, // Removes the __v field from documents
});

// Create the model. Mongoose will create a MongoDB collection named 'categories'.
const Category = model('Category', CategorySchema, 'categoryData');

export default Category;
